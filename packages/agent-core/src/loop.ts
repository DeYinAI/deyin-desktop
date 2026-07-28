import { compactMessages } from "./compaction.js";
import type { PermissionEngine, PermissionResolver } from "./permissions.js";
import { streamChatEvents } from "./stream.js";
import type { ToolRegistry } from "./tools/registry.js";
import {
  AuthRequiredError,
  type AgentMessage,
  type AgentToolCall,
  type TodoItem,
  type TokenUsage,
  type ToolContext,
} from "./types.js";

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
  | { type: "tool-end"; call: AgentToolCall; result: string; ok: boolean; denied?: boolean }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "usage"; usage: TokenUsage }
  | { type: "compaction"; truncatedToolResults: number; droppedMessages: number }
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
  cwd: string;
  thinking?: boolean;
  maxSteps?: number;
  signal?: AbortSignal;
  todos?: TodoItem[];
}

export interface AgentRunResult {
  reason: "completed" | "max-steps" | "aborted";
  finalText: string;
  usage: TokenUsage;
  steps: number;
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
  const budget = Math.floor((opts.contextLength ?? DEFAULT_CONTEXT_TOKENS) * BUDGET_FRACTION);
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const todos = opts.todos ?? [];

  const ctx: ToolContext = {
    cwd: opts.cwd,
    signal: opts.signal,
    todos,
    onTodosChanged: (t) => emit({ type: "todos", todos: [...t] }),
  };

  const append = (message: AgentMessage): void => {
    opts.messages.push(message);
    opts.onMessage?.(message);
  };

  let finalText = "";

  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal?.aborted) return finish("aborted", step - 1);

    const compaction = compactMessages(opts.messages, budget);
    if (compaction.droppedMessages > 0 || compaction.truncatedToolResults > 0) {
      emit({ type: "compaction", ...compaction });
    }

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
        tools: opts.tools.toWire(),
        thinking: opts.thinking,
        signal: opts.signal,
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
            emit({ type: "usage", usage: { ...usage } });
          }
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

    if (toolCalls.length === 0) return finish("completed", step);

    for (const call of toolCalls) {
      if (opts.signal?.aborted) {
        append(toolResult(call, "Aborted by the user before execution."));
        continue;
      }
      const outcome = await executeCall(call, opts, ctx, emit);
      append(toolResult(call, outcome));
    }
  }

  return finish("max-steps", maxSteps);

  function finish(reason: AgentRunResult["reason"], steps: number): AgentRunResult {
    emit({ type: "done", reason });
    return { reason, finalText, usage, steps };
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
    } catch {
      // Hook engine failures fail open by design.
    }
  }

  let action = opts.permissions.actionFor(tool);
  if (action === "ask") {
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
    const result = await tool.execute(args, ctx);
    emit({ type: "tool-end", call, result, ok: true });
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
