import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS } from "@deyin/host-core/shared";
import { Sidebar } from "../src/components/Sidebar.js";
import { I18nProvider } from "../src/i18n.js";
import { availableProducts } from "../src/products.js";
import type { Project, Thread } from "../src/threads.js";

// The sidebar reads saved sort/collapse state while rendering.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});

const noop = () => {};

function thread(id: string, patch: Partial<Thread> = {}): Thread {
  return { id, title: `Chat ${id}`, mode: "agent", createdAt: 1, updatedAt: 1, events: [], ...patch } as unknown as Thread;
}

const projects: Project[] = [
  {
    id: "p1",
    name: "alpha-repo",
    root: "/alpha",
    threads: [thread("working"), thread("done-away", { unread: true }), thread("seen"), thread("blocked", { unread: true })],
  } as Project,
];

function rowFor(markup: string, id: string): string {
  const match = markup.match(new RegExp(`<button[^>]*class="thread-row[^"]*"[^>]*>(?:(?!</button>).)*Chat ${id}(?:(?!</button>).)*</button>`));
  assert.ok(match, `row for ${id} should render`);
  return match[0];
}

function render(props: { runningThreadIds?: ReadonlySet<string>; pendingByThread?: Record<string, number> }): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { language: "en" },
      createElement(Sidebar, {
        platform: "desktop",
        activeView: "workspace",
        products: availableProducts(false),
        activeProduct: "code",
        onSelectProduct: noop,
        projects,
        activeProjectId: "p1",
        activeThreadId: null,
        renamingThreadId: null,
        user: null,
        settings: DEFAULT_SETTINGS,
        busy: false,
        connecting: false,
        onNewTask: noop,
        onNewProject: noop,
        onSelectProject: noop,
        onSelectThread: noop,
        onOpenSearch: noop,
        onThreadContext: noop,
        onProjectContext: noop,
        onRenameSubmit: noop,
        onConnect: noop,
        onLogout: noop,
        onChangeSettings: noop,
        onOpenUsage: noop,
        onOpenPlans: noop,
        onOpenSettings: noop,
        onOpenPlugins: noop,
        onOpenAutomations: noop,
        onOpenSuperagent: noop,
        onOpenCustomize: noop,
        ...props,
      }),
    ),
  );
}

test("a running session row shows the spinner and no unread dot", () => {
  const row = rowFor(render({ runningThreadIds: new Set(["working"]) }), "working");
  assert.match(row, /thread-row__spinner/);
  assert.match(row, /aria-label="Running"/);
  assert.doesNotMatch(row, /thread-row__unread/);
});

test("a finished, unopened session shows the unread dot instead of the spinner", () => {
  const row = rowFor(render({ runningThreadIds: new Set(["working"]) }), "done-away");
  assert.match(row, /thread-row__unread/);
  assert.doesNotMatch(row, /thread-row__spinner/);
});

test("a seen, idle session shows neither mark", () => {
  const row = rowFor(render({ runningThreadIds: new Set(["working"]) }), "seen");
  assert.doesNotMatch(row, /thread-row__spinner|thread-row__unread/);
});

test("a session blocked on an approval keeps its dot and badge, not a spinner", () => {
  const row = rowFor(render({ runningThreadIds: new Set(["blocked"]), pendingByThread: { blocked: 1 } }), "blocked");
  assert.doesNotMatch(row, /thread-row__spinner/);
  assert.match(row, /thread-row__unread/);
  assert.match(row, /thread-row__pending/);
});

test("without running ids (hosts that do not track them) rows render as before", () => {
  const markup = render({});
  assert.doesNotMatch(markup, /thread-row__spinner/);
  assert.match(rowFor(markup, "done-away"), /thread-row__unread/);
});
