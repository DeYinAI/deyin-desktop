import assert from "node:assert/strict";
import { test } from "node:test";
import type { UiNode, WindowInfo, WindowState } from "@deyin/computer-use-host";
import {
  formatAction,
  formatDisplays,
  formatLaunch,
  formatNode,
  formatWindowLine,
  formatWindowState,
  formatWindows,
} from "../host/computer-format.js";

const window1: WindowInfo = {
  id: "1509488",
  title: "Untitled - Notepad",
  app: "notepad",
  pid: 4242,
  bounds: { x: 100, y: 50, width: 800, height: 600 },
  displayId: "1",
  dpiScale: 1,
  minimized: false,
  foreground: true,
  elevated: false,
};

const node = (over: Partial<UiNode>): UiNode => ({
  ref: "s3e1",
  role: "Button",
  name: "OK",
  bounds: { x: 10, y: 20, width: 80, height: 24 },
  depth: 1,
  ...over,
});

test("a window line carries id, app, title, size and the flags that matter", () => {
  const line = formatWindowLine(window1);
  assert.match(line, /^1509488 \| notepad \| "Untitled - Notepad" \| pid 4242 \| 100,50 800x600/);
  assert.match(line, /foreground/);
  const hidden = formatWindowLine({ ...window1, foreground: false, minimized: true, elevated: true, dpiScale: 1.5 });
  assert.match(hidden, /minimized/);
  assert.match(hidden, /administrator/);
  assert.match(hidden, /150% scale/);
  assert.doesNotMatch(hidden, /foreground/);
});

test("listings say when they are empty", () => {
  assert.equal(formatWindows([]), "No windows are open.");
  assert.equal(formatDisplays([]), "No displays found.");
});

test("an element line shows ref, role, name, value, id, bounds and state", () => {
  const line = formatNode(
    node({ ref: "s3e7", role: "Edit", name: "Search", value: "hello", id: "txtSearch", focused: true, enabled: false, toggled: "On", depth: 0 }),
  );
  assert.equal(line, 's3e7 Edit "Search" value="hello" #txtSearch [10,20 80x24] (disabled, focused, toggled=On)');
});

test("a password field's contents are never shown", () => {
  const line = formatNode(node({ role: "Edit", name: "Password", value: "hunter2", password: true }));
  assert.doesNotMatch(line, /hunter2/);
  assert.match(line, /password/);
});

test("long names and values are clipped, and newlines flattened", () => {
  const line = formatNode(node({ name: "a\nb ".repeat(100), value: "v".repeat(500) }));
  assert.ok(line.length < 400, `${line.length}`);
  assert.doesNotMatch(line, /\n/);
  assert.match(line, /…/);
});

test("elements are indented by depth, relative to the shallowest one shown", () => {
  const state: WindowState = {
    window: window1,
    tree: {
      stateId: 3,
      visited: 3,
      truncated: false,
      nodes: [
        node({ ref: "s3e1", role: "Window", name: "Notepad", depth: 4 }),
        node({ ref: "s3e2", role: "Pane", name: "", depth: 5 }),
        node({ ref: "s3e3", role: "Button", name: "OK", depth: 6 }),
      ],
    },
  };
  const lines = formatWindowState(state).split("\n");
  assert.ok(lines.some((l) => l.startsWith("s3e1 Window")));
  assert.ok(lines.some((l) => l.startsWith("  s3e2 Pane")));
  assert.ok(lines.some((l) => l.startsWith("    s3e3 Button")));
});

test("the state explains the screenshot and the coordinate space for x/y", () => {
  const text = formatWindowState({
    window: window1,
    screenshot: { path: "C:\\shots\\a.png", width: 1280, height: 720, scale: 0.5, method: "PrintWindow" },
  });
  assert.match(text, /Screenshot: C:\\shots\\a\.png \(1280x720, scale 0\.50, PrintWindow\)/);
  assert.match(text, /pixels in this image, measured from the window's top-left corner/);
});

test("a missing screenshot says why instead of silently omitting it", () => {
  const text = formatWindowState({
    window: window1,
    screenshot: { path: null, width: 0, height: 0, scale: 1, method: "none", note: "The window is minimized." },
  });
  assert.match(text, /No screenshot: The window is minimized\./);
});

test("when the tree is unavailable the reason is given and the picture still comes back", () => {
  const text = formatWindowState({
    window: window1,
    screenshot: { path: "C:\\shots\\a.png", width: 800, height: 600, scale: 1, method: "PrintWindow" },
    treeError: "The app is not answering accessibility requests (a modal dialog?).",
  });
  assert.match(text, /Screenshot: /);
  assert.match(text, /Elements unavailable: The app is not answering/);
});

test("a truncated tree says so, and refs are tied to their observation", () => {
  const text = formatWindowState({
    window: window1,
    tree: { stateId: 9, visited: 5000, truncated: true, nodes: [node({ ref: "s9e1" })], note: "Showing the most interactive elements." },
  });
  assert.match(text, /observation 9/);
  assert.match(text, /truncated after visiting 5000/);
  assert.match(text, /refs from older observations are rejected/);
  assert.match(text, /Note: Showing the most interactive elements\./);
});

test("an action result says which method ran and whether the user's mouse or focus was touched", () => {
  assert.equal(
    formatAction({ ok: true, method: "msg", detail: "BM_CLICK", cursorMoved: false, focusChanged: false }, "click s1e2"),
    "OK: click s1e2 via msg (did not touch the user's mouse or focus) — BM_CLICK",
  );
  assert.match(
    formatAction({ ok: true, method: "input", cursorMoved: true, focusChanged: true }, "click (5, 6)"),
    /via input \(used the real mouse\/keyboard; moved the pointer and changed the focused window, then put it back\)/,
  );
  assert.match(
    formatAction({ ok: true, method: "uia", cursorMoved: false, focusChanged: true }, "click s1e2"),
    /via uia \(changed the focused window, then put it back\)/,
  );
  assert.match(formatAction({ ok: false, method: "uia" }, "click s1e2"), /^FAILED:/);
});

test("launch results cover a window, an id only, and no window yet", () => {
  assert.match(formatLaunch({ launched: "notepad", windowId: "1509488", pid: 4242, window: window1 }), /Window 1509488 \| notepad/);
  assert.match(formatLaunch({ launched: "notepad", windowId: "77", pid: 1 }), /window id 77/);
  assert.match(formatLaunch({ launched: "slowapp", windowId: "", pid: 9 }), /no window appeared yet/);
});
