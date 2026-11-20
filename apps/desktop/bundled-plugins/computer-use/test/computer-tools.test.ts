import assert from "node:assert/strict";
import { test } from "node:test";
import { computerUsePermissionRules, type ToolContext, type ToolDefinition } from "@deyin/agent-core";
import {
  HostCancelledError,
  HostRpcError,
  MockComputerUseHost,
  RPC_CODES,
  type ActionResult,
  type ComputerUseHostApi,
  type UiNode,
  type WindowInfo,
  type WindowState,
} from "@deyin/computer-use-host";
import { ComputerUseSession } from "../host/computer-session.js";
import { createComputerUseTools, translateError } from "../host/computer-tools.js";

const WINDOW: WindowInfo = {
  id: "100",
  title: "Notes",
  app: "notepad",
  pid: 7,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  displayId: "1",
  dpiScale: 1,
  minimized: false,
  foreground: true,
  elevated: false,
};

const OK: ActionResult = { ok: true, method: "msg", detail: "test", cursorMoved: false, focusChanged: false };

interface Call {
  method: string;
  args: unknown[];
}

/** A host that records every call and answers from `overrides`. */
class FakeHost extends MockComputerUseHost {
  calls: Call[] = [];
  override!: Partial<Record<string, () => unknown>>;

  constructor(overrides: Partial<Record<string, () => unknown>> = {}) {
    super();
    this.override = overrides;
    for (const method of ["click", "hover", "typeText", "pressKey", "scroll", "drag", "setValue", "getWindowState", "launchApp"] as const) {
      (this as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        this.calls.push({ method, args });
        const custom = this.override[method];
        if (custom) return Promise.resolve(custom());
        if (method === "getWindowState") return Promise.resolve(emptyState());
        if (method === "launchApp") return Promise.resolve({ launched: String(args[0]), windowId: "100", pid: 7, window: WINDOW });
        return Promise.resolve(OK);
      };
    }
  }
}

function emptyState(nodes: UiNode[] = []): WindowState {
  return { window: WINDOW, tree: { stateId: 1, visited: nodes.length, truncated: false, nodes } };
}

interface Rig {
  tools: Map<string, ToolDefinition>;
  host: FakeHost;
  session: ComputerUseSession;
  authorized: string[];
  authorizedApps: string[];
}

function rig(opts: { host?: FakeHost; deny?: boolean } = {}): Rig {
  const host = opts.host ?? new FakeHost();
  const session = new ComputerUseSession();
  const authorized: string[] = [];
  const authorizedApps: string[] = [];
  const tools = createComputerUseTools({
    session,
    host: () => host as ComputerUseHostApi,
    authorizeWindow: async (id) => {
      authorized.push(id);
      if (opts.deny) throw new Error('App "notepad" was denied for computer use.');
      return WINDOW;
    },
    authorizeApp: async (appId) => {
      authorizedApps.push(appId);
    },
    pollMs: 5,
  });
  return { tools: new Map(tools.map((t) => [t.name, t])), host, session, authorized, authorizedApps };
}

const ctx = (signal?: AbortSignal): ToolContext => ({ cwd: "/", todos: [], ...(signal ? { signal } : {}) });
const run = (r: Rig, name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
  const tool = r.tools.get(name);
  assert.ok(tool, `no tool ${name}`);
  return tool.execute(args, ctx(signal));
};

test("every tool has a permission rule, and every rule names a tool", () => {
  const r = rig();
  const rules = new Map(computerUsePermissionRules().map((x) => [x.tool, x.action]));
  assert.deepEqual([...r.tools.keys()].sort(), [...rules.keys()].sort());
  for (const tool of r.tools.values()) {
    // read-tier tools are the ones the rules allow; everything that acts must ask
    assert.equal(rules.get(tool.name), tool.tier === "read" ? "allow" : "ask", tool.name);
  }
});

test("click by ref sends the ref with button, count, modifiers and method", async () => {
  const r = rig();
  const out = await run(r, "computer_click", { window_id: "100", ref: "s1e5", button: "right", count: 2, modifiers: ["ctrl", "shift"], method: "input" });
  assert.deepEqual(r.host.calls, [
    { method: "click", args: ["100", { ref: "s1e5", button: "right", count: 2, modifiers: ["ctrl", "shift"], method: "input" }] },
  ]);
  assert.match(out, /^OK: right-click s1e5 via msg/);
});

test("click by point sends x and y and nothing else", async () => {
  const r = rig();
  await run(r, "computer_click", { window_id: "100", x: 12, y: 34 });
  assert.deepEqual(r.host.calls[0]?.args, ["100", { x: 12, y: 34 }]);
});

test("a ref wins over a point, and a missing target is rejected before anything happens", async () => {
  const r = rig();
  await run(r, "computer_click", { window_id: "100", ref: "s1e1", x: 1, y: 2 });
  assert.deepEqual(r.host.calls[0]?.args, ["100", { ref: "s1e1" }]);
  await assert.rejects(run(r, "computer_click", { window_id: "100" }), /ref .* or both x and y/);
  await assert.rejects(run(r, "computer_click", { window_id: "100", x: 3 }), /ref .* or both x and y/);
  assert.equal(r.host.calls.length, 1);
});

test("bad enum values are rejected rather than passed to the host", async () => {
  const r = rig();
  await assert.rejects(run(r, "computer_click", { window_id: "100", ref: "a", method: "magic" }), /method must be one of/);
  await assert.rejects(run(r, "computer_click", { window_id: "100", ref: "a", button: "side" }), /button must be one of/);
  assert.equal(r.host.calls.length, 0);
});

test("the window is authorized before any action, and a denial stops everything", async () => {
  const r = rig({ deny: true });
  await assert.rejects(run(r, "computer_click", { window_id: "100", ref: "s1e1" }), /was denied/);
  await assert.rejects(run(r, "computer_get_state", { window_id: "100" }), /was denied/);
  assert.deepEqual(r.authorized, ["100", "100"]);
  assert.equal(r.host.calls.length, 0);
  assert.equal(r.session.active, false, "a denied action must not light up the overlay");
});

test("window_id is required", async () => {
  const r = rig();
  await assert.rejects(run(r, "computer_click", { ref: "s1e1" }), /window_id is required/);
});

test("get_state passes its options and returns the readable outline", async () => {
  const r = rig();
  const out = await run(r, "computer_get_state", { window_id: "100", screenshot: false, depth: 3.9, query: "Save", max_nodes: 50 });
  assert.deepEqual(r.host.calls[0]?.args, ["100", { screenshot: false, tree: true, depth: 3, query: "Save", maxNodes: 50 }]);
  assert.match(out, /^Window 100 \| notepad \| "Notes"/);
});

test("type needs text, and sends the ref and method when given", async () => {
  const r = rig();
  await run(r, "computer_type", { window_id: "100", text: "hello", ref: "s1e3", method: "msg" });
  assert.deepEqual(r.host.calls[0], { method: "typeText", args: ["100", "hello", { ref: "s1e3", method: "msg" }] });
  await assert.rejects(run(r, "computer_type", { window_id: "100" }), /text is required/);
  await run(r, "computer_type", { window_id: "100", text: "" });
  assert.deepEqual(r.host.calls[1]?.args, ["100", "", {}], "typing an empty string is allowed");
});

test("press_key passes a chord through", async () => {
  const r = rig();
  await run(r, "computer_press_key", { window_id: "100", key: "ctrl+shift+t" });
  assert.deepEqual(r.host.calls[0], { method: "pressKey", args: ["100", "ctrl+shift+t"] });
  await assert.rejects(run(r, "computer_press_key", { window_id: "100" }), /key is required/);
});

test("scroll defaults to 600 down, keeps explicit deltas, and takes an optional target", async () => {
  const r = rig();
  await run(r, "computer_scroll", { window_id: "100" });
  await run(r, "computer_scroll", { window_id: "100", ref: "s1e9", delta_y: -300 });
  await run(r, "computer_scroll", { window_id: "100", x: 5, y: 6, delta_x: 200 });
  assert.deepEqual(r.host.calls.map((c) => c.args[1]), [{ deltaY: 600 }, { ref: "s1e9", deltaY: -300 }, { x: 5, y: 6, deltaX: 200 }]);
});

test("drag and hover accept refs or points on each end", async () => {
  const r = rig();
  await run(r, "computer_drag", { window_id: "100", from_ref: "s1e1", to_x: 40, to_y: 50 });
  await run(r, "computer_hover", { window_id: "100", x: 1, y: 2 });
  assert.deepEqual(r.host.calls[0], { method: "drag", args: ["100", { ref: "s1e1" }, { x: 40, y: 50 }] });
  assert.deepEqual(r.host.calls[1], { method: "hover", args: ["100", { x: 1, y: 2 }] });
  await assert.rejects(run(r, "computer_drag", { window_id: "100", from_ref: "s1e1" }), /to_ref .* or both to_x and to_y/);
});

test("set_value needs a ref and a value", async () => {
  const r = rig();
  await run(r, "computer_set_value", { window_id: "100", ref: "s1e3", value: "" });
  assert.deepEqual(r.host.calls[0], { method: "setValue", args: ["100", "s1e3", ""] });
  await assert.rejects(run(r, "computer_set_value", { window_id: "100", ref: "s1e3" }), /value is required/);
});

test("launch asks permission for the app, then returns the window it opened", async () => {
  const r = rig();
  const out = await run(r, "computer_launch_app", { app_id: "notepad.exe" });
  assert.deepEqual(r.authorizedApps, ["notepad.exe"]);
  assert.match(out, /^Launched notepad\.exe \(pid 7\)\. Window 100 \| notepad/);
});

test("listing tools do not light up the overlay", async () => {
  const r = rig();
  const seen: string[] = [];
  r.session.onState((s) => seen.push(s.phase));
  await run(r, "computer_list_windows", {});
  await run(r, "computer_list_apps", {});
  await run(r, "computer_list_displays", {});
  assert.deepEqual(seen, []);
});

test("an action does light it up while it runs, and the overlay label names the app", async () => {
  let release!: () => void;
  const host = new FakeHost({ click: () => new Promise<ActionResult>((resolve) => (release = () => resolve(OK))) });
  const r = rig({ host });
  const states: Array<{ phase: string; app?: string; action?: string }> = [];
  r.session.onState((s) => states.push(s));
  const pending = run(r, "computer_click", { window_id: "100", ref: "s1e1" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(states[0], { phase: "background", app: "notepad", action: "click s1e1" });
  release();
  await pending;
  assert.equal(states.at(-1)?.phase, "idle");
});

test("a takeover from the host pauses computer use and tells the model what to do", async () => {
  const host = new FakeHost({
    click: () => {
      throw new HostRpcError("The user took over the mouse or keyboard, so the action was abandoned.", RPC_CODES.tookOver);
    },
  });
  const r = rig({ host });
  await assert.rejects(run(r, "computer_click", { window_id: "100", ref: "s1e1" }), /user took over .* call computer_get_state/s);
  assert.equal(r.session.isPaused, true);
});

test("a stop becomes an instruction not to retry", async () => {
  const host = new FakeHost({
    click: () => {
      throw new HostCancelledError();
    },
  });
  const r = rig({ host });
  await assert.rejects(run(r, "computer_click", { window_id: "100", ref: "s1e1" }), /stopped by the user\. Do not retry/);
});

test("the run being cancelled stops an action before it reaches the host", async () => {
  const r = rig();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(run(r, "computer_click", { window_id: "100", ref: "s1e1" }, abort.signal), /stopped by the user/);
  assert.equal(r.host.calls.length, 0);
});

test("host timeouts point at dialogs and the next observation", () => {
  const err = translateError(new HostRpcError("click did not finish within 20s.", RPC_CODES.timedOut));
  assert.match(err.message, /click did not finish within 20s\..*computer_list_windows.*computer_get_state/);
});

test("other errors pass through untouched", () => {
  const original = new Error("That element no longer exists. Call get_state to re-observe.");
  assert.equal(translateError(original), original);
  assert.equal(translateError("plain").message, "plain");
});

test("wait for text returns as soon as the element appears", async () => {
  let polls = 0;
  const found: UiNode = { ref: "s2e4", role: "Button", name: "Save As", bounds: { x: 1, y: 2, width: 3, height: 4 }, depth: 1 };
  const host = new FakeHost({
    getWindowState: () => emptyState(++polls >= 3 ? [found] : []),
  });
  const r = rig({ host });
  const out = await run(r, "computer_wait", { window_id: "100", text: "save as", timeout_seconds: 5 });
  assert.equal(polls, 3);
  assert.match(out, /s2e4 Button "Save As"/);
  assert.deepEqual(host.calls[0]?.args[1], { screenshot: false, tree: true, query: "save as", maxNodes: 25 });
});

test("wait for text gives up at its timeout and says so", async () => {
  const r = rig();
  const out = await run(r, "computer_wait", { window_id: "100", text: "never", timeout_seconds: 1 });
  assert.match(out, /Timed out after 1s waiting for "never" in notepad "Notes"/);
});

test("wait for text needs a window", async () => {
  const r = rig();
  await assert.rejects(run(r, "computer_wait", { text: "x" }), /window_id is required/);
});

test("a plain wait pauses for the given seconds and can be stopped", async () => {
  const r = rig();
  const started = Date.now();
  assert.equal(await run(r, "computer_wait", { seconds: 0 }), "Waited 0s.");
  assert.ok(Date.now() - started < 500);

  const pending = run(r, "computer_wait", { seconds: 30 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  r.session.stop();
  await assert.rejects(pending, /stopped by the user/);
});

test("wait is capped at 30 seconds", async () => {
  const r = rig();
  const pending = run(r, "computer_wait", { seconds: 9999 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  r.session.stop();
  await assert.rejects(pending, /stopped by the user/);
  const tool = r.tools.get("computer_wait");
  assert.equal(tool?.summarize({ seconds: 5 }), "wait 5s");
});
