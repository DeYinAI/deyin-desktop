import { estimateContextUsage, type AgentMessage } from "@deyin/agent-core";
import type { ContextUsageSnapshot, ThreadEvent } from "@deyin/contract";

/** Conversation-only context estimate when the host has not emitted a snapshot yet. */
export function estimateContextFromThreadEvents(
  events: ThreadEvent[],
  contextLength: number,
): ContextUsageSnapshot {
  const messages: AgentMessage[] = [];
  for (const event of events) {
    if (event.kind === "user") messages.push({ role: "user", content: event.text });
    else if (event.kind === "assistant") messages.push({ role: "assistant", content: event.text });
  }
  return estimateContextUsage({ contextLength, messages });
}
