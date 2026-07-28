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

export function emptyThread(title = "New task"): Thread {
  return { id: newId("thread"), title, age: "now", events: [] };
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
