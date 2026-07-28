/** Renderer-side session model: projects hold threads, threads hold a timeline of
 * structured events (plain chat plus agent activity cards). */

export type ThreadEvent =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "plan"; steps: { text: string; done: boolean }[]; badge?: string }
  | { kind: "file"; name: string; subtitle: string; adds: number; dels: number }
  | { kind: "model-switch"; from: string; to: string }
  | { kind: "skill"; name: string }
  | { kind: "thought"; label: string }
  | { kind: "worked"; seconds: number };

export interface Thread {
  id: string;
  title: string;
  /** Relative age label shown in the sidebar ("now", "2h", "4d"). */
  age: string;
  events: ThreadEvent[];
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
}

export interface Project {
  id: string;
  name: string;
  threads: Thread[];
}

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
