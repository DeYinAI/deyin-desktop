import type { AgentMessage } from "@deyin/agent-core";

export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      summary: string;
      status: "done" | "error" | "denied";
      preview: string;
    }
  | { kind: "notice"; id: string; text: string; tone: "info" | "warn" | "error" };

let counter = 0;
export function nextId(): string {
  counter += 1;
  return `i${counter}`;
}

export function toolPreview(result: string, lines = 4): string {
  return result
    .split("\n")
    .slice(0, lines)
    .map((l) => (l.length > 120 ? `${l.slice(0, 120)}\u2026` : l))
    .join("\n");
}

/** Rebuild display items from a persisted transcript (session resume). */
export function messagesToItems(messages: AgentMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        break;
      case "user":
        // Skip synthetic compaction markers.
        if (m.content.startsWith("[Context note:") || m.content.startsWith("[Conversation compacted")) break;
        items.push({ kind: "user", id: nextId(), text: m.content });
        break;
      case "assistant":
        if (m.content.trim().length > 0) items.push({ kind: "assistant", id: nextId(), text: m.content });
        break;
      case "tool": {
        const status = m.content.startsWith("ERROR:") ? "error" : m.content.startsWith("Denied:") ? "denied" : "done";
        items.push({
          kind: "tool",
          id: nextId(),
          name: m.toolName,
          summary: "",
          status,
          preview: toolPreview(m.content, 2),
        });
        break;
      }
    }
  }
  return items;
}
