import { completeChat } from "./stream.js";
import type { AgentMessage } from "./types.js";

/** Rough chars/4 heuristic plus per-message overhead; good enough for budgeting. */
export function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length + 16;
    if (m.role === "assistant") {
      for (const c of m.toolCalls ?? []) chars += c.name.length + c.arguments.length + 16;
    }
  }
  return Math.ceil(chars / 4);
}

const KEEP_RECENT_MESSAGES = 8;
const TOOL_RESULT_TRUNCATE_CHARS = 600;

export interface CompactionResult {
  truncatedToolResults: number;
  droppedMessages: number;
}

/**
 * Deterministic in-place compaction, applied before each request when the estimated
 * token count exceeds the budget:
 *
 * 1. Truncate old tool results (everything except the trailing KEEP_RECENT_MESSAGES).
 * 2. Still over budget: drop whole user-turn groups from the oldest side (never the
 *    system prompt or the most recent turns), replacing them with a single marker.
 */
export function compactMessages(messages: AgentMessage[], budgetTokens: number): CompactionResult {
  const result: CompactionResult = { truncatedToolResults: 0, droppedMessages: 0 };
  if (estimateTokens(messages) <= budgetTokens) return result;

  const protectedFrom = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
  for (let i = 0; i < protectedFrom; i++) {
    const m = messages[i]!;
    if (m.role === "tool" && m.content.length > TOOL_RESULT_TRUNCATE_CHARS) {
      m.content = `${m.content.slice(0, TOOL_RESULT_TRUNCATE_CHARS)}\n... [tool result truncated during compaction]`;
      result.truncatedToolResults += 1;
    }
  }
  if (estimateTokens(messages) <= budgetTokens) return result;

  // Group indices into user-turn groups: [user, ...everything until next user].
  const systemCount = countLeadingSystem(messages);
  const groups: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = systemCount; i < messages.length; i++) {
    if (messages[i]!.role === "user") {
      if (start !== -1) groups.push({ start, end: i });
      start = i;
    }
  }
  if (start !== -1) groups.push({ start, end: messages.length });

  // Drop oldest groups until under budget, always keeping the final group.
  let dropUpTo = -1;
  for (let g = 0; g < groups.length - 1; g++) {
    dropUpTo = groups[g]!.end;
    const removed = dropUpTo - systemCount;
    const remaining: AgentMessage[] = [
      ...messages.slice(0, systemCount),
      marker(removed),
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

function countLeadingSystem(messages: AgentMessage[]): number {
  let n = 0;
  while (n < messages.length && messages[n]!.role === "system") n += 1;
  return n;
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
