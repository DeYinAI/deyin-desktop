import type { ContextUsageSnapshot, ThreadEvent } from "@deyin/contract";

/** Rough token count for browser-side estimates (no agent-core / native tokenizer). */
function roughTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

/** Conversation-only context estimate when the host has not emitted a snapshot yet. */
export function estimateContextFromThreadEvents(
  events: ThreadEvent[],
  contextLength: number,
): ContextUsageSnapshot {
  let usedTokens = 0;
  for (const event of events) {
    if (event.kind === "user" || event.kind === "assistant") {
      usedTokens += roughTokens(event.text);
    }
  }
  const percent = contextLength > 0 ? Math.min(100, (usedTokens / contextLength) * 100) : 0;
  return {
    contextLength,
    usedTokens,
    percent,
    categories: [{ id: "conversation", label: "Conversation", tokens: usedTokens }],
  };
}
