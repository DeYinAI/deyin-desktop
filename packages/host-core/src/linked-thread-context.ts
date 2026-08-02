import type { Thread, ThreadEvent } from "./types.js";

const MAX_EVENTS = 12;
const MAX_CHARS = 8_000;

/** Summarize linked threads for injection into the user message. */
export function buildLinkedThreadContext(threads: Thread[], linkedIds: string[]): string {
  if (linkedIds.length === 0) return "";
  const byId = new Map(threads.map((t) => [t.id, t]));
  const blocks: string[] = [];
  for (const id of linkedIds) {
    const thread = byId.get(id);
    if (!thread) continue;
    blocks.push(formatThreadBlock(thread));
  }
  return blocks.join("\n\n---\n\n").slice(0, MAX_CHARS);
}

function formatThreadBlock(thread: Thread): string {
  const lines: string[] = [`# Thread: ${thread.title} (${thread.id})`];
  const events = thread.events.filter((e) => e.kind === "user" || e.kind === "assistant").slice(-MAX_EVENTS);
  for (const event of events) {
    if (event.kind === "user") lines.push(`User: ${event.text}`);
    else if (event.kind === "assistant") lines.push(`Assistant: ${truncate(event.text, 500)}`);
  }
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** Plain-text preview for the # picker. */
export function threadPreview(events: ThreadEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "user" || e.kind === "assistant") return truncate(e.text.replace(/\s+/g, " ").trim(), 80);
  }
  return "Empty thread";
}
