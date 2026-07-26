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

/** Demo content so a fresh install shows the full range of session UI. */
export function seedProjects(): Project[] {
  const demo: Thread = {
    id: newId("thread"),
    title: "Solar system demo",
    age: "now",
    events: [
      {
        kind: "plan",
        badge: "Polish orbit animation",
        steps: [
          { text: "Scene -> canvas with starfield and eight orbiting planets", done: true },
          { text: "Controls -> drag to rotate, wheel to zoom", done: true },
          { text: "Finish -> speed slider and pause button", done: false },
        ],
      },
      { kind: "file", name: "solar-system.html", subtitle: "Website · HTML", adds: 214, dels: 0 },
      { kind: "model-switch", from: "GLM-5.2", to: "Kimi K2.7 Code" },
      { kind: "user", text: "Build me an interactive 3D solar system in a single HTML file." },
      { kind: "worked", seconds: 18 },
      {
        kind: "assistant",
        text: "Done - the interactive solar system is ready. Drag to rotate the scene, scroll to zoom, and use the slider in the corner to change the simulation speed.",
      },
      { kind: "file", name: "solar-system.html", subtitle: "Website · HTML", adds: 38, dels: 12 },
      { kind: "skill", name: "browser-use:control-browser" },
      { kind: "thought", label: "Thought for a few seconds" },
    ],
  };

  return [
    { id: newId("proj"), name: "getting-started", threads: [] },
    {
      id: newId("proj"),
      name: "DeyinProject",
      threads: [
        demo,
        { id: newId("thread"), title: "Fix login redirect", age: "2h", events: [] },
        { id: newId("thread"), title: "Add dark theme tokens", age: "4d", events: [] },
        { id: newId("thread"), title: "3D city builder game", age: "6d", events: [] },
      ],
    },
  ];
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
