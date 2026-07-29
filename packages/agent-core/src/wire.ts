import type { AgentMessage } from "./types.js";

/**
 * Serialize the transcript into the OpenAI chat-completions wire format: assistant
 * tool calls become `tool_calls` entries and tool results become role:"tool" messages
 * keyed by `tool_call_id`.
 */
export function toWireMessages(messages: AgentMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "assistant": {
        const hasToolCalls = m.toolCalls !== undefined && m.toolCalls.length > 0;
        const wire: Record<string, unknown> = {
          role: "assistant",
          // Tool-call-only turns: send null (providers reject empty strings there).
          // Empty turns without tool calls: send "" — `content: null` alone is
          // rejected by many providers and would poison every later request.
          content: m.content.length > 0 ? m.content : hasToolCalls ? null : "",
        };
        if (hasToolCalls) {
          wire.tool_calls = m.toolCalls!.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          }));
        }
        return wire;
      }
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });
}
