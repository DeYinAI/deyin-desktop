import { completeChat } from "./stream.js";
import { estimateMessageTokens } from "./tokenizer.js";
import type { AgentMessage } from "./types.js";

/** Token-aware estimate; falls back gracefully for empty transcripts. */
export function estimateTokens(messages: AgentMessage[]): number {
  return estimateMessageTokens(messages);
}

const KEEP_RECENT_MESSAGES = 8;
const TOOL_RESULT_TRUNCATE_CHARS = 600;
const TOOL_ARGS_TRUNCATE_CHARS = 600;
const IMPORTANCE_KEEP_THRESHOLD = 4;

export interface CompactionResult {
  truncatedToolResults: number;
  truncatedToolArgs: number;
  droppedMessages: number;
  summarizedMessages?: number;
}

/**
 * Score how important a message is to keep under pressure.
 * Higher = keep longer. Errors, recent turns, and system prompts win.
 */
export function scoreMessageImportance(msg: AgentMessage, index: number, total: number): number {
  const recency = total <= 1 ? 1 : index / (total - 1); // 0..1
  let score = recency * 3;

  if (msg.role === "system") return 100;
  if (msg.role === "user") score += 2;
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) score += 1;

  const text = msg.content;
  if (/\b(error|exception|failed|denied|traceback|enoent)\b/i.test(text)) score += 3;
  if (msg.role === "tool" && text.startsWith("ERROR:")) score += 3;
  if (msg.role === "tool" && text.length < 200) score += 1; // short results are cheap to keep
  if (msg.role === "user" && text.startsWith("[Context note:")) score -= 2;
  if (msg.role === "user" && text.startsWith("[Conversation compacted")) score += 4;

  return score;
}

/**
 * Deterministic in-place compaction, applied before each request when the estimated
 * token count exceeds the budget:
 *
 * 1. Truncate old tool results (everything except the trailing KEEP_RECENT_MESSAGES),
 *    preferring to keep high-importance (error) tool results longer.
 * 2. Still over budget: truncate old tool-call arguments the same way.
 * 3. Still over budget: drop whole user-turn groups from the oldest/lowest-importance
 *    side (never the system prompt or the most recent turns), replacing them with a marker.
 */
export function compactMessages(messages: AgentMessage[], budgetTokens: number): CompactionResult {
  const result: CompactionResult = {
    truncatedToolResults: 0,
    truncatedToolArgs: 0,
    droppedMessages: 0,
  };
  if (estimateTokens(messages) <= budgetTokens) return result;

  const protectedFrom = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
  // Truncate low-importance tool results first.
  const toolIndexes: { i: number; score: number }[] = [];
  for (let i = 0; i < protectedFrom; i++) {
    const m = messages[i]!;
    if (m.role === "tool" && m.content.length > TOOL_RESULT_TRUNCATE_CHARS) {
      toolIndexes.push({ i, score: scoreMessageImportance(m, i, messages.length) });
    }
  }
  toolIndexes.sort((a, b) => a.score - b.score);
  for (const { i, score } of toolIndexes) {
    if (estimateTokens(messages) <= budgetTokens) break;
    if (score >= IMPORTANCE_KEEP_THRESHOLD + 2) continue; // keep critical errors longer
    const m = messages[i]!;
    if (m.role === "tool" && m.content.length > TOOL_RESULT_TRUNCATE_CHARS) {
      m.content = `${m.content.slice(0, TOOL_RESULT_TRUNCATE_CHARS)}\n... [tool result truncated during compaction]`;
      result.truncatedToolResults += 1;
    }
  }
  if (estimateTokens(messages) <= budgetTokens) return result;

  for (let i = 0; i < protectedFrom; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.toolCalls) continue;
    const nextCalls = m.toolCalls.map((call) => {
      if (call.arguments.length <= TOOL_ARGS_TRUNCATE_CHARS) return call;
      const patched = truncateArgsJson(call.arguments);
      if (patched === null) return call;
      result.truncatedToolArgs += 1;
      return { ...call, arguments: patched };
    });
    m.toolCalls = nextCalls;
  }
  if (estimateTokens(messages) <= budgetTokens) return result;

  // Progressive summarization for low-importance mid-conversation assistant prose.
  for (let i = 0; i < protectedFrom; i++) {
    if (estimateTokens(messages) <= budgetTokens) break;
    const m = messages[i]!;
    if (m.role !== "assistant" || m.toolCalls?.length) continue;
    const score = scoreMessageImportance(m, i, messages.length);
    if (score >= IMPORTANCE_KEEP_THRESHOLD) continue;
    if (m.content.length > 400) {
      m.content = summarizeLocally(m.content);
      result.summarizedMessages = (result.summarizedMessages ?? 0) + 1;
    }
  }
  if (estimateTokens(messages) <= budgetTokens) return result;

  const systemCount = countLeadingSystem(messages);
  const groups: { start: number; end: number; score: number }[] = [];
  let start = -1;
  for (let i = systemCount; i < messages.length; i++) {
    if (messages[i]!.role === "user") {
      if (start !== -1) {
        groups.push({ start, end: i, score: groupImportance(messages, start, i) });
      }
      start = i;
    }
  }
  if (start !== -1) groups.push({ start, end: messages.length, score: groupImportance(messages, start, messages.length) });

  // Drop oldest groups first, but if two early groups exist prefer dropping lower importance.
  const droppable = groups.slice(0, Math.max(0, groups.length - 1));
  droppable.sort((a, b) => a.start - b.start || a.score - b.score);

  let dropUpTo = -1;
  for (const g of droppable) {
    dropUpTo = Math.max(dropUpTo, g.end);
    const remaining: AgentMessage[] = [
      ...messages.slice(0, systemCount),
      marker(0),
      ...messages.slice(dropUpTo),
    ];
    if (estimateTokens(remaining) <= budgetTokens) break;
  }
  if (dropUpTo > 0) {
    const removed = dropUpTo - systemCount;
    messages.splice(systemCount, removed, marker(removed));
    result.droppedMessages = removed;
  }
  return result;
}

function groupImportance(messages: AgentMessage[], start: number, end: number): number {
  let best = 0;
  for (let i = start; i < end; i++) {
    best = Math.max(best, scoreMessageImportance(messages[i]!, i, messages.length));
  }
  return best;
}

/** Cheap extractive summary — first + last sentence / error lines. */
function summarizeLocally(content: string): string {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => /\b(error|failed|denied|exception)\b/i.test(l));
  const head = lines.slice(0, 2);
  const tail = lines.slice(-2);
  const parts = [...new Set([...head, ...errors.slice(0, 3), ...tail])];
  const summary = parts.join(" ").slice(0, 360);
  return `[Summarized during compaction] ${summary}${content.length > 360 ? "…" : ""}`;
}

function countLeadingSystem(messages: AgentMessage[]): number {
  let n = 0;
  while (n < messages.length && messages[n]!.role === "system") n += 1;
  return n;
}

/**
 * Truncate large string values inside a tool-call's JSON arguments while keeping
 * the object's shape (same keys, same primitive types) so strict providers that
 * validate historical `tool_calls.function.arguments` against the tool's schema
 * still accept the replayed message. Returns null if the arguments are not valid
 * JSON, in which case the caller leaves them untouched.
 */
function truncateArgsJson(raw: string, max = TOOL_ARGS_TRUNCATE_CHARS): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const truncated = truncateStringsInPlace(parsed, max);
  return truncated ? JSON.stringify(parsed) : null;
}

function truncateStringsInPlace(value: unknown, max: number): boolean {
  if (typeof value === "string") return false;
  if (Array.isArray(value)) {
    let changed = false;
    for (let i = 0; i < value.length; i++) {
      const item = value[i]!;
      if (typeof item === "string" && item.length > max) {
        value[i] = `${item.slice(0, max)}… [arguments truncated during compaction]`;
        changed = true;
      } else {
        changed = truncateStringsInPlace(item, max) || changed;
      }
    }
    return changed;
  }
  if (value && typeof value === "object") {
    let changed = false;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === "string" && v.length > max) {
        (value as Record<string, unknown>)[key] = `${v.slice(0, max)}… [arguments truncated during compaction]`;
        changed = true;
      } else {
        changed = truncateStringsInPlace(v, max) || changed;
      }
    }
    return changed;
  }
  return false;
}

function marker(removed: number): AgentMessage {
  return {
    role: "user",
    content: `[Context note: ${removed || "several"} earlier messages were removed to stay within the context window. Ask the user to repeat anything important that is missing.]`,
  };
}

/**
 * Model-driven compaction used by /compact: replaces the conversation with the system
 * prompt plus a model-written summary. Returns the new transcript (does not mutate).
 */
export async function compactWithModel(opts: {
  apiBaseUrl: string;
  token: string;
  model: string;
  messages: AgentMessage[];
}): Promise<AgentMessage[]> {
  const systemCount = countLeadingSystem(opts.messages);
  const { content } = await completeChat({
    apiBaseUrl: opts.apiBaseUrl,
    token: opts.token,
    model: opts.model,
    messages: [
      ...opts.messages,
      {
        role: "user",
        content:
          "Summarize this conversation for a fresh context window: the user's goal, key decisions, files touched with their current state, what has been completed, and what remains. Be specific and dense; use plain text.",
      },
    ],
  });
  return [
    ...opts.messages.slice(0, systemCount),
    { role: "user", content: `[Conversation compacted. Summary of everything so far:]\n\n${content}` },
    { role: "assistant", content: "Understood. I have the summary and will continue from there." },
  ];
}
