import type { ReasoningEffort } from "@deyin/host-core/shared";
import {
  comparePrefixShapes,
  computePrefixShape,
  shouldBumpLogRewriteVersion,
} from "./cache/prefix-tracker.js";
import { compactMessages } from "./compaction.js";
import {
  estimateContextUsage,
  splitToolSchemaTokens,
  type ContextSnapshot,
  type SystemPromptSections,
} from "./context-usage.js";
import type { EvidenceLedger } from "./evidence/ledger.js";
import { EvidenceLedger as EvidenceLedgerClass, isMutationTool } from "./evidence/ledger.js";
import { blockPrematureCompletion, checkMutationReadiness } from "./evidence/gates.js";
import { OptimizationTracker, type OptimizationMetrics } from "./optimization.js";
import type { ModelRole, PreviousStep, StepRouter } from "./model-routing.js";
import { buildRecallSuffix } from "./recall.js";
import type { PermissionDecision, PermissionEngine, PermissionResolver } from "./permissions.js";
import { streamChatEvents } from "./stream.js";
import type { StreamImage } from "@deyin/host-core";
import { inlineImageDirective } from "./tools/generate-image.js";
import type { ProviderApiFormat } from "./transports.js";
import type { ToolRegistry } from "./tools/registry.js";
import {
  AuthRequiredError,
  type AgentMessage,
  type AgentToolCall,
  type FileChange,
  type MemoryBridge,
  type TodoItem,
  type TokenUsage,
  type ToolContext,
  type ToolShell,
} from "./types.js";
import type { WireOptions } from "./wire.js";

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
  | { type: "tool-start"; call: AgentToolCall; summary: string; cwd?: string }
  | { type: "tool-delta"; call: AgentToolCall; delta: string }
  | { type: "tool-end"; call: AgentToolCall; result: string; ok: boolean; denied?: boolean; fromCache?: boolean; cwd?: string }
  | { type: "file-change"; change: FileChange }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "usage"; usage: TokenUsage }
  | { type: "context-snapshot"; snapshot: ContextSnapshot }
  | { type: "optimization"; metrics: OptimizationMetrics }
  | { type: "compaction"; truncatedToolResults: number; truncatedToolArgs: number; droppedMessages: number }
  | { type: "evidence-gate"; code: string; message: string; toolName?: string }
  | { type: "model-routed"; step: number; role: ModelRole; model: string; providerId?: string }
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
  /** Reasoning effort for models that support it ("low" | "medium" | "high"). */
  effort?: ReasoningEffort;
  /** Provider wire format; defaults to "chat-completions". */
  apiFormat?: ProviderApiFormat;
  /** Anthropic-compatible gateways using Bearer instead of x-api-key. */
  authHeader?: boolean;
  /** Max output tokens; omitted when unset (Anthropic defaults to 32768). */
  maxTokens?: number;
  maxSteps?: number;
  signal?: AbortSignal;
  todos?: TodoItem[];
  /** Optional host-backed persistent shell for the bash tool. */
  shell?: ToolShell;
  /** Extra tool context hooks (interaction, mode changes, skills, etc.). */
  toolContext?: Partial<ToolContext>;
  /** Background-memory bridge: enables automatic recall before the run's user turn. */
  memory?: MemoryBridge;
  /** Wire-level compression + Anthropic cache_control. */
  wire?: WireOptions;
  /** Stable prompt cache key for OpenAI-compatible providers (shared across steps). */
  promptCacheKey?: string;
  /** Structured system-prompt slices for Context Usage category accounting. */
  systemSections?: SystemPromptSections;
  /** Delivery mode: enforce evidence gates (todos + acceptance criteria + sign-offs). */
  evidenceGatesEnabled?: boolean;
  /** Delivery mode: ledger recording mutations/verifications (created by the host when omitted). */
  evidenceLedger?: EvidenceLedger;
  /**
   * Per-step model routing. When set, the loop asks the router which model to
   * use before every request, so plan/implement/ask/tool phases can run on
   * different models and a mid-run `switch_mode` re-routes immediately.
   * Omit it (the default) and the run uses `model` throughout.
   */
  router?: StepRouter;
  /**
   * The selected model declares image output in the catalog (Gemini flash-image,
   * an image tool on the Responses API). Asks the provider for pictures and lets
   * the loop store whatever the model draws.
   */
  imageOutput?: boolean;
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
  // Recomputed per step: a routed model may have a different context window.
  const budgetFor = (windowTokens: number): number =>
    Math.max(1_024, Math.floor(windowTokens * BUDGET_FRACTION) - schemaTokens);
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 };
  const todos = opts.todos ?? [];
  const tracker = new OptimizationTracker();
  const promptCacheKey = opts.promptCacheKey ?? `deyin-agent:${opts.model}:${opts.cwd}`;
  // Stable across role-routed model switches: provider-side prefix caches key on
  // the byte prefix (system+tools+history), not the model id, so appending a
  // model suffix only fragmented caches without any matching benefit.
  const cacheKeyFor = (_model: string): string => promptCacheKey;
  const evidenceGates = opts.evidenceGatesEnabled === true;
  const ledger = opts.evidenceLedger ?? (evidenceGates ? new EvidenceLedgerClass() : undefined);

  const ctx: ToolContext = {
    cwd: opts.cwd,
    signal: opts.signal,
    todos,
    onTodosChanged: (t) => emit({ type: "todos", todos: [...t] }),
    onFileChanged: (change) => emit({ type: "file-change", change }),
    shell: opts.shell,
    messages: opts.messages,
    evidenceLedger: ledger,
    ...opts.toolContext,
  };

  const append = (message: AgentMessage): void => {
    opts.messages.push(message);
    opts.onMessage?.(message);
  };

  // Automatic memory recall: append a bounded, low-authority suffix to the run's
  // user turn (the transcript's last message). The suffix lives only in this
  // run's in-memory transcript — it is never persisted or injected elsewhere.
  // Idempotent: a message that already carries a recall suffix is left alone.
  if (opts.memory) {
    const last = opts.messages.at(-1);
    if (last && last.role === "user" && !last.content.includes("<recall>")) {
      const suffix = buildRecallSuffix(opts.memory, last.content);
      if (suffix) last.content = `${last.content}\n\n${suffix}`;
    }
  }

  let finalText = "";
  /** What the last step produced; drives the cheap `tool` role (see roleForStep). */
  let previousStep: PreviousStep | undefined;
  /** Model used by the previous step, so `model-routed` only fires on a change. */
  let previousModel = "";
  /** Prefix shape of the previous request; drives per-turn cache diagnostics. */
  let previousPrefixShape: ReturnType<typeof computePrefixShape> | undefined;
  /** Bumped when compaction mutates the transcript prefix (invalidates provider cache). */
  let logRewriteVersion = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal?.aborted) return finish("aborted", step - 1);

    // Resolve this step's model before compaction: the window we compact to
    // must be the window of the model that is about to see the transcript.
    const routed = opts.router?.({
      step,
      mode: typeof ctx.sessionMeta?.mode === "string" ? ctx.sessionMeta.mode : undefined,
      previous: previousStep,
    });
    const stepModel = routed?.model ?? opts.model;
    const stepWindow = routed?.contextLength ?? contextTokens;
    const stepWire = opts.wire ? { ...opts.wire, model: stepModel } : undefined;
    if (routed && stepModel !== previousModel) {
      emit({ type: "model-routed", step, role: routed.role, model: stepModel, providerId: routed.providerId });
    }
    previousModel = stepModel;

    const compaction = compactMessages(opts.messages, budgetFor(stepWindow));
    if (compaction.droppedMessages > 0 || compaction.truncatedToolResults > 0 || compaction.truncatedToolArgs > 0) {
      if (shouldBumpLogRewriteVersion(compaction)) logRewriteVersion += 1;
      emit({ type: "compaction", ...compaction });
    }

    // Post-compaction / pre-request: the window the model actually sees this step.
    // Never invent a contextLength for the UI — compaction alone uses DEFAULT_CONTEXT_TOKENS.
    emit({
      type: "context-snapshot",
      snapshot: estimateContextUsage({
        contextLength: routed?.contextLength ?? opts.contextLength ?? 0,
        messages: opts.messages,
        systemSections: opts.systemSections,
        tools: toolSchemas,
        wire: stepWire,
      }),
    });

    const token = await (routed?.getToken ?? opts.getToken)();
    // Empty string is valid: local providers (Ollama) need no key.
    if (token === null || token === undefined) throw new AuthRequiredError();

    emit({ type: "step-start", step });

    let content = "";
    let reasoning = "";
    let toolCalls: AgentToolCall[] = [];
    let streamImages: StreamImage[] = [];
    try {
      for await (const event of streamChatEvents({
        apiBaseUrl: routed?.apiBaseUrl ?? opts.apiBaseUrl,
        token,
        model: stepModel,
        messages: opts.messages,
        tools: toolSchemas,
        thinking: opts.thinking,
        effort: opts.effort,
        apiFormat: routed?.apiFormat ?? opts.apiFormat,
        authHeader: routed?.authHeader ?? opts.authHeader,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        wire: stepWire,
        promptCacheKey: cacheKeyFor(stepModel),
        promptCacheOptions: opts.wire?.enablePromptCaching === false ? undefined : { mode: "implicit" },
        imageOutput: opts.imageOutput,
      })) {
        if (event.type === "text") {
          emit({ type: "text-delta", delta: event.delta });
        } else if (event.type === "reasoning") {
          emit({ type: "reasoning-delta", delta: event.delta });
        } else {
          content = event.content;
          reasoning = event.reasoning;
          toolCalls = event.toolCalls;
          streamImages = event.images ?? [];
          if (event.usage) {
            usage.promptTokens += event.usage.promptTokens;
            usage.completionTokens += event.usage.completionTokens;
            usage.totalTokens += event.usage.totalTokens;
            if (event.usage.cachedPromptTokens) {
              usage.cachedPromptTokens = (usage.cachedPromptTokens ?? 0) + event.usage.cachedPromptTokens;
              tracker.recordCachedPromptTokens(event.usage.cachedPromptTokens);
            }
            emit({ type: "usage", usage: { ...usage } });
          }
          // Prefix-cache diagnostics: attribute hit/miss tokens to system/tools/log_rewrite
          // churn so the UI and telemetry reflect real provider cache behaviour.
          const shape = computePrefixShape(
            opts.messages.find((m) => m.role === "system"),
            toolSchemas,
            logRewriteVersion,
            schemaTokens,
          );
          const cached = event.usage?.cachedPromptTokens ?? 0;
          const prompt = event.usage?.promptTokens ?? 0;
          const diag = comparePrefixShapes(previousPrefixShape, shape, cached, Math.max(0, prompt - cached));
          previousPrefixShape = shape;
          tracker.recordPrefixShape(shape, diag);
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

    // A model that draws its own pictures returns them beside the text. Store
    // each one and append its embed directive so the reply renders the image —
    // exactly what generate_image does for the images endpoint.
    if (streamImages.length > 0) {
      const embedded = await storeStreamImages(streamImages, ctx);
      if (embedded.length > 0) {
        const block = (content.endsWith("\n") || content.length === 0 ? "" : "\n\n") + embedded.join("\n");
        content += block;
        emit({ type: "text-delta", delta: block });
      }
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

    // Record what this step did so the next one can be recognised as pure
    // read-only churn. Unknown tools count as non-read: never route a step that
    // followed something we cannot classify to the cheap model.
    const toolNames = toolCalls.map((call) => call.name);
    previousStep = {
      hadProse: content.trim().length > 0,
      toolNames,
      allRead: toolNames.every((name) => opts.tools.get(name)?.tier === "read"),
    };

    if (toolCalls.length === 0) {
      // Delivery mode: reject premature "all done" claims until every step is
      // signed off. Append the gate message as a user turn and keep the loop going.
      if (evidenceGates && ledger) {
        const gate = blockPrematureCompletion(content, todos, ledger);
        if (!gate.ok) {
          emit({ type: "evidence-gate", code: gate.code, message: gate.message });
          append({ role: "user", content: `Delivery gate (${gate.code}): ${gate.message} Continue working the steps; do not repeat this summary.` });
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
      const outcomes = await executeSameStepCalls(toolCalls, opts, ctx, emit, tracker, ledger);
      for (let i = 0; i < toolCalls.length; i++) {
        append(toolResult(toolCalls[i]!, outcomes[i]!));
      }
      emit({ type: "optimization", metrics: tracker.get() });
    }
  }

  return finish("max-steps", maxSteps);

  function finish(reason: AgentRunResult["reason"], steps: number): AgentRunResult {
    emit({ type: "done", reason });
    return { reason, finalText, usage, steps, optimization: tracker.get() };
  }
}

/**
 * Run one step's tool calls, concurrent where that is safe.
 *
 * Read-tier tools have no side effects, so a consecutive run of them executes
 * together. Everything else runs exclusively, in the order the model asked for
 * it: two `edit` calls against the same file are a read-modify-write race that
 * silently drops one of the edits, and a shared todo list or evidence ledger has
 * the same problem. Unknown tools count as exclusive — we cannot classify them.
 *
 * Results come back in `toolCalls` order either way, which is what providers
 * require of the appended tool messages.
 */
async function executeSameStepCalls(
  toolCalls: AgentToolCall[],
  opts: AgentRunOptions,
  ctx: ToolContext,
  emit: (event: AgentEvent) => void,
  tracker: OptimizationTracker,
  ledger?: EvidenceLedger,
): Promise<string[]> {
  const outcomes = new Array<string>(toolCalls.length);
  const isRead = (call: AgentToolCall): boolean => opts.tools.get(call.name)?.tier === "read";
  let i = 0;
  while (i < toolCalls.length) {
    if (!isRead(toolCalls[i]!)) {
      outcomes[i] = await executeCall(toolCalls[i]!, opts, ctx, emit, tracker, ledger);
      i += 1;
      continue;
    }
    let end = i;
    while (end < toolCalls.length && isRead(toolCalls[end]!)) end += 1;
    const batch = toolCalls.slice(i, end);
    const results = await Promise.all(batch.map((call) => executeCall(call, opts, ctx, emit, tracker, ledger)));
    for (let k = 0; k < results.length; k++) outcomes[i + k] = results[k]!;
    i = end;
  }
  return outcomes;
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
  ledger?: EvidenceLedger,
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
  const cwd = safeMeta(tool.meta, args, ctx);
  emit({ type: "tool-start", call, summary, cwd });

  // Delivery mode: block mutations until todos carry acceptance criteria.
  if (opts.evidenceGatesEnabled && ledger && isMutationTool(call.name) && tool.tier !== "read") {
    const gate = checkMutationReadiness(ctx.todos);
    if (!gate.ok) {
      emit({ type: "evidence-gate", code: gate.code, message: gate.message, toolName: call.name });
      const msg = `ERROR: delivery gate (${gate.code}): ${gate.message}`;
      emit({ type: "tool-end", call, result: msg, ok: false, denied: true });
      return msg;
    }
  }

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
    } catch {
      // Hook engine failures fail open by design.
    }
  }

  let action = opts.permissions.actionFor(tool);
  if (action === "ask") {
    let decision: PermissionDecision;
    try {
      decision = await opts.resolvePermission({ toolName: tool.name, tier: tool.tier, args, summary });
    } catch {
      // A crashed/rejected dialog must not tear down the run with a dangling
      // assistant tool_calls message in the transcript — treat it as a denial.
      decision = "deny";
    }
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
    ledger?.observeToolCall(call.name, args, false);
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
    emit({ type: "tool-end", call, result, ok: true, cwd });
    ledger?.observeToolCall(call.name, args, true);
    if (opts.storeToolCache) await opts.storeToolCache(call, args, result).catch(() => undefined);
    if (opts.afterTool) await opts.afterTool(call, result, true).catch(() => undefined);
    return result;
  } catch (err) {
    const msg = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    emit({ type: "tool-end", call, result: msg, ok: false, cwd });
    ledger?.observeToolCall(call.name, args, false);
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

function safeMeta(
  meta: ((args: Record<string, unknown>, ctx: ToolContext) => { cwd?: string }) | undefined,
  args: Record<string, unknown>,
  ctx: ToolContext,
): string | undefined {
  if (!meta) return undefined;
  try {
    return meta(args, ctx).cwd;
  } catch {
    return undefined;
  }
}


/**
 * Persist images a chat model produced inside its completion and return one
 * embed directive per stored picture. Needs a host image bridge with `save`;
 * without one the pictures cannot be stored, so the reply keeps the text only.
 */
async function storeStreamImages(images: StreamImage[], ctx: ToolContext): Promise<string[]> {
  const bridge = ctx.imageGen;
  if (!bridge?.save) return [];
  const lines: string[] = [];
  for (const image of images) {
    try {
      const stored = await bridge.save({
        ...(image.base64 !== undefined ? { base64: image.base64 } : {}),
        ...(image.url !== undefined ? { url: image.url } : {}),
        mediaType: image.mediaType,
      });
      lines.push(inlineImageDirective(stored.file));
    } catch (err) {
      // Surfaced in the reply rather than swallowed: the user asked for a picture.
      lines.push(`*(an image could not be stored: ${err instanceof Error ? err.message : String(err)})*`);
    }
  }
  return lines;
}
