import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS, type ProductId } from "@deyin/host-core/shared";
import { Sidebar } from "../src/components/Sidebar.js";
import { I18nProvider } from "../src/i18n.js";
import { availableProducts } from "../src/products.js";
import type { Project, Thread } from "../src/threads.js";
import type { View } from "../src/views.js";

// The sidebar reads saved sort/collapse state while rendering.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});

const noop = () => {};

function thread(id: string, mode: Thread["mode"] = "agent"): Thread {
  return { id, title: `Chat ${id}`, mode, createdAt: 1, updatedAt: 1, events: [] } as unknown as Thread;
}

const projects: Project[] = [{ id: "p1", name: "alpha-repo", root: "/alpha", threads: [thread("t1"), thread("r1", "conductor")] } as Project];

function render(opts: { product?: ProductId; view?: View; chatOnly?: boolean; botBody?: ReactNode } = {}): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { language: "en" },
      createElement(Sidebar, {
        platform: "desktop",
        activeView: opts.view ?? "workspace",
        products: availableProducts(opts.chatOnly ?? false),
        activeProduct: opts.product ?? "code",
        onSelectProduct: noop,
        botBody: opts.botBody,
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
      }),
    ),
  );
}

test("the brand row is the product switcher, naming the open product", () => {
  assert.match(render(), /aria-label="Switch product: Deyin Code"/);
  assert.match(render({ product: "conductor", view: "conductor" }), /aria-label="Switch product: Deyin Conductor"/);
  assert.match(render({ product: "bot", view: "bot" }), /aria-label="Switch product: Deyin Bot"/);
});

test("the primary action is the product's own, with its shortcut", () => {
  assert.match(render(), /sidebar__new-label">New session</);
  assert.match(render({ product: "bot", view: "bot" }), /sidebar__new-label">New Bot</);
  assert.match(render({ product: "conductor", view: "conductor" }), /sidebar__new-label">New run</);
  assert.match(render({ product: "bot", view: "bot" }), /sidebar__new-kbd">Ctrl\+N</);
});

test("Code shows its workspaces and their conversations", () => {
  const html = render();
  assert.match(html, />Workspaces</);
  assert.match(html, /alpha-repo/);
  assert.match(html, /Chat t1/);
});

test("Bot shows the Bot body and none of the workspace or run lists", () => {
  const html = render({ product: "bot", view: "bot", botBody: createElement("div", { id: "roster-here" }, "roster") });
  assert.match(html, /id="roster-here"/);
  assert.match(html, /sidebar__ws-title">Bots</);
  assert.doesNotMatch(html, /alpha-repo/);
  assert.doesNotMatch(html, /Chat t1/);
  assert.doesNotMatch(html, /Search workspaces/);
  assert.doesNotMatch(html, /Add workspace folder/);
});

test("Bot with no body supplied renders an empty sidebar body, not another product's", () => {
  const html = render({ product: "bot", view: "bot" });
  assert.doesNotMatch(html, /alpha-repo/);
  assert.doesNotMatch(html, /TARGET REPOSITORY/);
});

test("Conductor shows its runs and target repository, and not the Bot body", () => {
  const html = render({ product: "conductor", view: "conductor", botBody: createElement("div", { id: "roster-here" }) });
  assert.match(html, /TARGET REPOSITORY/);
  assert.match(html, /sidebar__ws-title">Conductor</);
  assert.doesNotMatch(html, /id="roster-here"/);
});

test("Conductor lists saved pipelines, and neither Code nor Bot does", () => {
  assert.match(render({ product: "conductor", view: "conductor" }), /SAVED PIPELINES/);
  assert.doesNotMatch(render(), /SAVED PIPELINES/);
  assert.doesNotMatch(render({ product: "bot", view: "bot" }), /SAVED PIPELINES/);
});

test("a shared page keeps the product's shell", () => {
  const html = render({ product: "bot", view: "settings", botBody: createElement("div", { id: "roster-here" }) });
  assert.match(html, /id="roster-here"/);
});

test("the old 'Switch to Conductor' menu item is gone", () => {
  for (const product of ["code", "conductor", "bot"] as const) {
    const html = render({ product });
    assert.doesNotMatch(html, /Switch to Conductor/, product);
    assert.doesNotMatch(html, /Switch to Workspace/, product);
  }
});

test("a chat-only host shows a plain mark with no switcher", () => {
  const html = render({ chatOnly: true });
  assert.doesNotMatch(html, /Switch product/);
  assert.match(html, /product-switcher--static/);
});

test("only Conductor shows the detected external agents card", () => {
  assert.match(render({ product: "conductor", view: "conductor" }), /DETECTED AGENTS/);
  assert.doesNotMatch(render(), /DETECTED AGENTS/);
  assert.doesNotMatch(render({ product: "bot", view: "bot" }), /DETECTED AGENTS/);
});
