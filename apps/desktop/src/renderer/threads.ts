/** Renderer-side session model: projects hold threads, threads hold a timeline of
 * structured events (plain chat plus agent activity cards). The types live in
 * @deyin/host-core so the ProjectsStore and both transports share them. */
export type { Project, Thread, ThreadEvent, ProjectsState } from "@deyin/host-core/shared";

import type { Thread, ThreadEvent } from "@deyin/host-core/shared";

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export const DEFAULT_THREAD_TITLE = "New task";

/** Provisional title from the first user message (truncated at a word boundary). */
export function deriveTitle(text: string, maxLen = 48): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return DEFAULT_THREAD_TITLE;
  if (collapsed.length <= maxLen) return collapsed;
  const slice = collapsed.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxLen * 0.5 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trim()}…`;
}

export function emptyThread(title = DEFAULT_THREAD_TITLE): Thread {
  return { id: newId("thread"), title, age: "now", events: [] };
}

/** First markdown heading, else a stable plan.md label for the chat artifact card. */
export function planTitleFromMarkdown(markdown: string): string {
  const heading = markdown.match(/^#{1,3}\s+(.+)$/m);
  const title = heading?.[1]?.replace(/\s+/g, " ").trim();
  return title || "plan.md";
}

/** Prefer the longer plan draft so a short follow-up cannot wipe a full document. */
export function isBetterPlanDoc(candidate: string, current: string): boolean {
  const next = candidate.trim();
  const prev = current.trim();
  if (!next) return false;
  if (!prev) return true;
  return next.length >= prev.length;
}

/** Stable file-card name for a plan artifact. */
export function planFileNameFromTitle(title: string): string {
  const slug = title
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug ? `${slug}.md` : "plan.md";
}

/** Reduce a thread's timeline to plain chat messages for the completion API. */
export function toChatMessages(events: ThreadEvent[]): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const e of events) {
    if (e.kind === "user") out.push({ role: "user", content: e.text });
    else if (e.kind === "assistant") out.push({ role: "assistant", content: e.text });
  }
  return out;
}
