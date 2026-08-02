import { compactMessages } from "./compaction.js";
import {
  estimateContextUsage,
  splitToolSchemaTokens,
  type ContextSnapshot,
  type SystemPromptSections,
} from "./context-usage.js";
import { OptimizationTracker, type OptimizationMetrics } from "./optimization.js";
import type { PermissionEngine, PermissionRequest, PermissionResolver } from "./permissions.js";
import { streamChatEvents } from "./stream.js";
import type { ToolRegistry } from "./tools/registry.js";
import {
  AuthRequiredError,
  type AgentMessage,
  type AgentToolCall,
  type FileChange,
  type TodoItem,
  type TokenUsage,
  type ToolContext,
  type ToolShell,
} from "./types.js";
import type { WireOptions } from "./wire.js";
import {
  buildPromptCacheKey,
  comparePrefixShapes,
  computePrefixShape,
  shouldBumpLogRewriteVersion,
} from "./cache/prefix-tracker.js";
import {
  blockPrematureCompletion,
  checkFinalizationReadiness,
  checkMutationReadiness,
  isMutationTool,
} from "./evidence/index.js";
import type { EvidenceLedger } from "./evidence/ledger.js";

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_CONTEXT_TOKENS = 128_000;
/** Fraction of the context window we let the transcript grow to before compaction. */
const BUDGET_FRACTION = 0.75;
const HARD_TOOL_RESULT_CAP = 50_000;

export type AgentEvent =
  | { type: "step-start"; step: number }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "assistant-message"; message: AgentMessage }
  | { type: "tool-start"; call: AgentToolCall; summary: string }
  | { type: "tool-delta"; call: AgentToolCall; delta: string }
  | { type: "tool-end"; call: AgentToolCall; result: string; ok: boolean; denied?: boolean; fromCache?: boolean }
  | { type: "file-change"; change: FileChange }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "usage"; usage: TokenUsage }
  | { type: "context-snapshot"; snapshot: ContextSnapshot }
  | { type: "optimization"; metrics: OptimizationMetrics }
  | { type: "compaction"; truncatedToolResults: number; truncatedToolArgs: number; droppedMessages: number; softWarning?: boolean }
  | { type: "evidence-gate"; code: string; message: string }
  | { type: "done"; reason: AgentRunResult["reason"] };

export interface AgentRunOptions {
  apiBaseUrl: string;
  /** Returns a fresh access token (auto-refreshed) or null when signed out. */
  getToken: () => Promise<string | null>;
  model: string;
  /** Model context window in tokens; drives compaction. */
  contextLength?: number;
  /** Full transcript including the system prompt. Mutated in place as the run progresses. */
  messages: AgentMessage[];
  tools: ToolRegistry;
  permissions: PermissionEngine;
  /** Called for "ask" tools; headless runs auto-deny unless --yes set skipAll. */
  resolvePermission: PermissionResolver;
  /** When true, prompt even if permission engine returned allow (e.g. high-risk computer actions). */
  forcePermissionPrompt?: (req: PermissionRequest) => boolean;
  onEvent?: (event: AgentEvent) => void;
  /** Persistence hook: fired for every message appended to the transcript. */
  onMessage?: (message: AgentMessage) => void;
  /** Lifecycle hooks (hooks.json): return { block } to veto a tool call. */
  beforeTool?: (call: AgentToolCall, args: Record<string, unknown>, summary: string) => Promise<{ block?: string } | void>;
  afterTool?: (call: AgentToolCall, result: string, ok: boolean) => Promise<void>;
  /**
   * Optional semantic tool-result cache (from @deyin/optimization-plugin).
   * Return a cached result string to skip execution; return null to execute.
   */
  lookupToolCache?: (call: AgentToolCall, args: Record<string, unknown>) => Promise<string | null>;
  /** Store a successful tool result in the semantic cache. */
  storeToolCache?: (call: AgentToolCall, args: Record<string, unknown>, result: string) => Promise<void>;
  cwd: string;
  thinking?: boolean;
  maxSteps?: number;
  signal?: AbortSignal;
  todos?: TodoItem[];
  /** Optional host-backed persistent shell for the bash tool. */
  shell?: ToolShell;
  /** Extra tool context hooks (interaction, mode changes, skills, etc.). */
  toolContext?: Partial<ToolContext>;
  /** Wire-level compression + Anthropic cache_control. */
  wire?: WireOptions;
  /** Stable prompt cache key for OpenAI-compatible providers (shared across steps). */
  promptCacheKey?: string;
  /** Composer mode (agent/plan/ask/delivery) for default prompt cache key when promptCacheKey is unset. */
  composerMode?: string;
  /** Structured system-prompt slices for Context Usage category accounting. */
  systemSections?: SystemPromptSections;
  /** Active verifiable objective (goal mode). */
  goalText?: string;
  /** Delivery mode: enforce evidence readiness gates. */
  evidenceGatesEnabled?: boolean;
  /** Session evidence ledger; created when gates enabled and not provided. */
  evidenceLedger?: EvidenceLedger;
}

export interface AgentRunResult {
  reason: "completed" | "max-steps" | "aborted";
  finalText: string;
  usage: TokenUsage;
  steps: number;
  optimization?: OptimizationMetrics;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * The agentic loop: request a completion, surface text/reasoning deltas, execute any
 * requested tools behind the permission engine, append results, and repeat until the
 * model stops calling tools or the step cap is reached.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const emit = opts.onEvent ?? (() => undefined);
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const contextTokens = opts.contextLength ?? DEFAULT_CONTEXT_TOKENS;
  const toolSchemas = opts.tools.toWire();
  const schemaSplit = splitToolSchemaTokens(toolSchemas);
  const schemaTokens = schemaSplit.tools + schemaSplit.mcp + schemaSplit.subagents;
  // Leave room for tool schemas on every request; compactMessages only sees transcript tokens.
  const budget = Math.max(1_024, Math.floor(contextTokens * BUDGET_FRACTION) - schemaTokens);
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 };
  const todos = opts.todos ?? [];
  const tracker = new OptimizationTracker();
  const evidenceGatesEnabled = opts.evidenceGatesEnabled === true;
  const evidenceLedger = opts.evidenceLedger;
  
  // Prefix stability tracking
  let logRewriteVersion = 0;
  const systemMessage = opts.messages.find((m) => m.role === "system");
  const initialPrefixShape = computePrefixShape(systemMessage, toolSchemas, logRewriteVersion, schemaTokens);
  const promptCacheKey = opts.promptCacheKey ?? buildPromptCacheKey(
    opts.model,
    opts.composerMode ?? "agent",
    initialPrefixShape.systemHash,
    initialPrefixShape.toolsHash
  );
  
  let goalMet = false;

  const parentGoalReport = opts.toolContext?.onGoalReport;
  const ctx: ToolContext = {
    cwd: opts.cwd,
    signal: opts.signal,
    todos,
    onTodosChanged: (t) => emit({ type: "todos", todos: [...t] }),
    onFileChanged: (change) => emit({ type: "file-change", change }),
    shell: opts.shell,
    messages: opts.messages,
    goalText: opts.goalText,
    evidenceLedger,
    evidenceGatesEnabled,
    ...opts.toolContext,
    onGoalReport: (report) => {
      if (report.met && opts.goalText) goalMet = true;
      parentGoalReport?.(report);
    },
  };

  const append = (message: AgentMessage): void => {
    opts.messages.push(message);
    opts.onMessage?.(message);
  };

  let finalText = "";

  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal?.aborted) return finish("aborted", step - 1);

    const compaction = compactMessages(opts.messages, budget);
    
    // Soft warning: context growing but not yet compacting (preserves cache)
    if (compaction.softWarning) {
      emit({ type: "compaction", ...compaction });
    }
    
    // Hard compaction: prefix mutated, bump rewrite version
    if (shouldBumpLogRewriteVersion(compaction)) {
      logRewriteVersion += 1;
      emit({ type: "compaction", ...compaction });
    }

    // Post-compaction / pre-request: compute prefix shape and cache diagnostics
    const currentSystem = opts.messages.find((m) => m.role === "system");
    const prefixShape = computePrefixShape(currentSystem, toolSchemas, logRewriteVersion, schemaTokens);
    
    // Post-compaction / pre-request: the window the model actually sees this step.
    // Never invent a contextLength for the UI — compaction alone uses DEFAULT_CONTEXT_TOKENS.
    emit({
      type: "context-snapshot",
      snapshot: estimateContextUsage({
        contextLength: opts.contextLength ?? 0,
        messages: opts.messages,
        systemSections: opts.systemSections,
        tools: toolSchemas,
        wire: opts.wire,
      }),
    });

    const token = await opts.getToken();
    if (!token) throw new AuthRequiredError();

    emit({ type: "step-start", step });

    let content = "";
    let reasoning = "";
    let toolCalls: AgentToolCall[] = [];
    try {
      for await (const event of streamChatEvents({
        apiBaseUrl: opts.apiBaseUrl,
        token,
        model: opts.model,
        messages: opts.messages,
        tools: toolSchemas,
        thinking: opts.thinking,
        signal: opts.signal,
        wire: opts.wire,
        promptCacheKey,
        promptCacheOptions: opts.wire?.enablePromptCaching === false ? undefined : { mode: "implicit" },
      })) {
        if (event.type === "text") {
          emit({ type: "text-delta", delta: event.delta });
        } else if (event.type === "reasoning") {
          emit({ type: "reasoning-delta", delta: event.delta });
} else {
 content = event.content;
 reasoning = event.reasoning;
 toolCalls = event.toolCalls;
 if (event.usage) {
 usage.promptTokens += event.usage.promptTokens;
 usage.completionTokens += event.usage.completionTokens;
 usage.totalTokens += event.usage.totalTokens;
                if (event.usage.cachedPromptTokens) {
                  usage.cachedPromptTokens = (usage.cachedPromptTokens ?? 0) + event.usage.cachedPromptTokens;
                  tracker.recordCachedPromptTokens(event.usage.cachedPromptTokens);
                }
                
                // Cache diagnostics: compare prefix shapes and attribute cache hit/miss
                const cacheDiagnostics = comparePrefixShapes(
                  tracker.getPreviousPrefixShape(),
                  prefixShape,
                  event.usage.cachedPromptTokens ?? 0,
                  event.usage.promptTokens - (event.usage.cachedPromptTokens ?? 0)
                );
                tracker.recordPrefixShape(prefixShape, cacheDiagnostics);
                
                emit({ type: "usage", usage: { ...usage } });
              }
              if (event.compression) {
                tracker.recordCompression(event.compression.originalTokens, event.compression.compressedTokens);
              }
              // Single optimization emit per done event (avoids duplicate IPC for usage + compression).
              emit({ type: "optimization", metrics: tracker.get() });
 }
      }
    } catch (err) {
      if (opts.signal?.aborted || isAbortError(err)) return finish("aborted", step);
      throw err;
    }

    const assistant: AgentMessage = {
      role: "assistant",
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    append(assistant);
    emit({ type: "assistant-message", message: assistant });
    if (content) finalText = content;

    if (toolCalls.length === 0) {
      if (evidenceGatesEnabled && evidenceLedger) {
        const premature = blockPrematureCompletion(finalText, todos, evidenceLedger);
        if (!premature.ok) {
          emit({ type: "evidence-gate", code: premature.code, message: premature.message });
          append({
            role: "user",
            content: `[Delivery mode gate] ${premature.message} Use complete_step for each todo before finishing.`,
          });
          continue;
        }
        const finalReady = checkFinalizationReadiness(todos, evidenceLedger);
        if (!finalReady.ok) {
          emit({ type: "evidence-gate", code: finalReady.code, message: finalReady.message });
          append({
            role: "user",
            content: `[Delivery mode gate] ${finalReady.message}`,
          });
          continue;
        }
      }
      return finish("completed", step);
    }

    // Run same-step tool calls concurrently (Cursor-style). Results are appended
    // in the original tool_calls order so the transcript stays valid for providers
    // that require matching order.
    if (opts.signal?.aborted) {
      for (const call of toolCalls) {
        append(toolResult(call, "Aborted by the user before execution."));
      }
    } else {
      const outcomes = await Promise.all(toolCalls.map((call) => executeCall(call, opts, ctx, emit, tracker)));
      for (let i = 0; i < toolCalls.length; i++) {
        append(toolResult(toolCalls[i]!, outcomes[i]!));
      }
      emit({ type: "optimization", metrics: tracker.get() });
      if (goalMet) return finish("completed", step);
    }
  }

  return finish("max-steps", maxSteps);

  function finish(reason: AgentRunResult["reason"], steps: number): AgentRunResult {
    emit({ type: "done", reason });
    return { reason, finalText, usage, steps, optimization: tracker.get() };
  }
}

function toolResult(call: AgentToolCall, content: string): AgentMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    toolName: call.name,
    content: content.length > HARD_TOOL_RESULT_CAP ? `${content.slice(0, HARD_TOOL_RESULT_CAP)}\n... [truncated]` : content,
  };
}

async function executeCall(
  call: AgentToolCall,
  opts: AgentRunOptions,
  ctx: ToolContext,
  emit: (event: AgentEvent) => void,
  tracker: OptimizationTracker,
): Promise<string> {
  const tool = opts.tools.get(call.name);
  if (!tool) {
    emit({ type: "tool-start", call, summary: call.name });
    const msg = `ERROR: unknown tool "${call.name}". Available tools: ${opts.tools.names().join(", ")}.`;
    emit({ type: "tool-end", call, result: msg, ok: false });
    return msg;
  }

  let args: Record<string, unknown>;
  try {
    args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
  } catch {
    emit({ type: "tool-start", call, summary: call.name });
    const msg = "ERROR: tool arguments were not valid JSON. Emit a single well-formed JSON object.";
    emit({ type: "tool-end", call, result: msg, ok: false });
    return msg;
  }

  const summary = safeSummary(tool.summarize, args, call.name);
  emit({ type: "tool-start", call, summary });

  // Lifecycle hooks run before the permission prompt so a blocking hook never
  // bothers the user with a dialog for an action that would be vetoed anyway.
  if (opts.beforeTool) {
    try {
      const hookResult = await opts.beforeTool(call, args, summary);
      if (hookResult?.block) {
        const msg = `Blocked by hook: ${hookResult.block}`;
        emit({ type: "tool-end", call, result: msg, ok: false, denied: true });
        return msg;
      }
    } catch (err) {
      const msg = `Blocked by hook: ${err instanceof Error ? err.message : String(err)}`;
      emit({ type: "tool-end", call, result: msg, ok: false, denied: true });
      return msg;
    }
  }

  if (ctx.evidenceGatesEnabled && ctx.evidenceLedger && isMutationTool(tool.name) && tool.name !== "complete_step") {
    const gate = checkMutationReadiness(ctx.todos);
    if (!gate.ok) {
      emit({ type: "evidence-gate", code: gate.code, message: gate.message });
      const msg = `Blocked by delivery gate: ${gate.message}`;
      emit({ type: "tool-end", call, result: msg, ok: false, denied: true });
      return msg;
    }
  }

  let action = opts.permissions.actionFor(tool);
  const forcePrompt =
    action !== "deny" &&
    (opts.forcePermissionPrompt?.({ toolName: tool.name, tier: tool.tier, args, summary }) ?? false);
  if (action === "deny") {
    const msg = "Denied: the user rejected this tool call. Do not retry it; adjust your approach or ask the user.";
    emit({ type: "tool-end", call, result: msg, ok: false, denied: true });
    return msg;
  }
  if (action === "ask" || forcePrompt) {
    const decision = await opts.resolvePermission({ toolName: tool.name, tier: tool.tier, args, summary });
    if (decision === "allow-always") {
      opts.permissions.grantForSession(tool.name);
      action = "allow";
    } else {
      action = decision === "allow" ? "allow" : "deny";
    }
  }
  if (action === "deny") {
    const msg = "Denied: the user rejected this tool call. Do not retry it; adjust your approach or ask the user.";
    emit({ type: "tool-end", call, result: msg, ok: false, denied: true });
    return msg;
  }

  try {
    if (opts.lookupToolCache) {
      const cached = await opts.lookupToolCache(call, args);
      if (cached !== null) {
        tracker.recordToolCache(true);
        emit({ type: "tool-end", call, result: cached, ok: true, fromCache: true });
        if (opts.afterTool) await opts.afterTool(call, cached, true).catch(() => undefined);
        return cached;
      }
      tracker.recordToolCache(false);
    }

    // Bind onOutput per call so streaming tool output carries the right call id.
    const callCtx: ToolContext = {
      ...ctx,
      onOutput: (delta) => emit({ type: "tool-delta", call, delta }),
    };
    const result = await tool.execute(args, callCtx);
    emit({ type: "tool-end", call, result, ok: true });
    ctx.evidenceLedger?.observeToolCall(tool.name, args, true);
    if (opts.storeToolCache) await opts.storeToolCache(call, args, result).catch(() => undefined);
    if (opts.afterTool) await opts.afterTool(call, result, true).catch(() => undefined);
    return result;
  } catch (err) {
    const msg = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    emit({ type: "tool-end", call, result: msg, ok: false });
    if (opts.afterTool) await opts.afterTool(call, msg, false).catch(() => undefined);
    return msg;
  }
}

function safeSummary(
  summarize: (args: Record<string, unknown>) => string,
  args: Record<string, unknown>,
  fallback: string,
): string {
  try {
    return summarize(args) || fallback;
  } catch {
    return fallback;
  }
}
