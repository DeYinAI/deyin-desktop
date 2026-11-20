import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CdpPage, renderAxTree, type AxNode, type CdpTransport, type RefEntry } from "../host/cdp-page.js";
import { keyEventParams, parseChord } from "../host/cdp-keys.js";

/* AX helpers ------------------------------------------------------------------ */

function ax(id: string, role: string, name: string, extra: Partial<AxNode> = {}): AxNode {
  return { nodeId: id, role: { type: "role", value: role }, name: { type: "string", value: name }, ...extra };
}

function sampleTree(): AxNode[] {
  return [
    ax("1", "RootWebArea", "Shop", { childIds: ["2", "3", "6"] }),
    ax("2", "heading", "Sign in", { childIds: ["2a"], properties: [{ name: "level", value: { type: "integer", value: 1 } }] }),
    ax("2a", "StaticText", "Sign in", { parentId: "2" }),
    ax("3", "form", "", { parentId: "1", childIds: ["4", "5"] }),
    ax("4", "textbox", "Email", { parentId: "3", backendDOMNodeId: 40, value: { type: "string", value: "a@b.c" }, properties: [{ name: "required", value: { type: "boolean", value: true } }] }),
    ax("5", "button", "Continue", { parentId: "3", backendDOMNodeId: 50, childIds: ["5a"] }),
    ax("5a", "StaticText", "Continue", { parentId: "5" }),
    ax("6", "link", "Help", { parentId: "1", backendDOMNodeId: 60, properties: [{ name: "url", value: { type: "string", value: "https://shop.test/help" } }] }),
    ax("7", "generic", "", { parentId: "1" }),
  ];
}

function refAllocator() {
  const byBackend = new Map<number, string>();
  let n = 1;
  return (entry: RefEntry): string => {
    const existing = byBackend.get(entry.backendNodeId);
    if (existing) return existing;
    const ref = `e${n++}`;
    byBackend.set(entry.backendNodeId, ref);
    return ref;
  };
}

describe("renderAxTree", () => {
  it("renders an outline with refs on interactive nodes only, skipping noise", () => {
    const { text } = renderAxTree(sampleTree(), refAllocator());
    assert.match(text, /- page "Shop"/);
    assert.match(text, /- heading "Sign in" \[level=1\]/);
    assert.match(text, /- textbox "Email" value="a@b\.c" \[required\] \[ref=e1\]/);
    assert.match(text, /- button "Continue" \[ref=e2\]/);
    assert.match(text, /- link "Help" → https:\/\/shop\.test\/help \[ref=e3\]/);
    assert.ok(!/generic/.test(text), "unnamed generic wrappers are skipped");
    assert.equal((text.match(/text "Sign in"/g) ?? []).length, 0, "static text duplicating its parent's name is dropped");
    assert.equal((text.match(/Continue/g) ?? []).length, 1);
  });

  it("keeps refs stable for the same backend node across snapshots", () => {
    const alloc = refAllocator();
    renderAxTree(sampleTree(), alloc);
    const reordered = sampleTree().reverse();
    const again = renderAxTree(reordered, alloc).text;
    assert.match(again, /Email.*\[ref=e1\]/);
    assert.match(again, /Continue.*\[ref=e2\]/);
  });

  it("filters by query and keeps ancestors for context", () => {
    const { text } = renderAxTree(sampleTree(), refAllocator(), { query: "email" });
    assert.match(text, /- page "Shop"/);
    assert.match(text, /textbox "Email"/);
    assert.ok(!/Continue/.test(text));
    assert.match(renderAxTree(sampleTree(), refAllocator(), { query: "zzz" }).text, /no elements matching "zzz"/);
  });

  it("can re-root at one element", () => {
    const { text } = renderAxTree(sampleTree(), refAllocator(), { rootBackendId: 50 });
    assert.match(text, /^- button "Continue"/);
    assert.ok(!/Email/.test(text));
  });

  it("truncates with a pointer to narrow the snapshot", () => {
    const many: AxNode[] = [ax("r", "RootWebArea", "Big", { childIds: Array.from({ length: 200 }, (_, i) => `b${i}`) })];
    for (let i = 0; i < 200; i++) many.push(ax(`b${i}`, "button", `Button number ${i}`, { parentId: "r", backendDOMNodeId: 1000 + i }));
    const result = renderAxTree(many, refAllocator(), { maxChars: 600 });
    assert.equal(result.truncated, true);
    assert.match(result.text, /truncated: pass `query` or a `ref`/);
    assert.ok(result.text.length < 800);
  });
});

/* Keys ------------------------------------------------------------------------ */

describe("parseChord", () => {
  it("parses plain, named and modified keys", () => {
    assert.equal(parseChord("a").key.code, "KeyA");
    assert.equal(parseChord("Enter").key.vk, 13);
    assert.equal(parseChord("f5").key.key, "F5");
    const select = parseChord("Control+A");
    assert.equal(select.modifiers, 2);
    assert.deepEqual(select.commands, ["selectAll"]);
    assert.equal(parseChord("ctrl+shift+k").modifiers, 2 | 8);
    assert.equal(parseChord("Shift+a").key.key, "A");
    assert.equal(parseChord("Control++").key.key, "+");
  });

  it("rejects unknown keys and modifiers with a helpful message", () => {
    assert.throws(() => parseChord("Banana"), /Unknown key "Banana"/);
    assert.throws(() => parseChord("Hyper+a"), /Unknown modifier "Hyper"/);
    assert.throws(() => parseChord(""), /Empty key/);
  });

  it("only attaches text when no ctrl/alt/meta is held", () => {
    assert.equal(keyEventParams(parseChord("a"), "keyDown").text, "a");
    assert.equal(keyEventParams(parseChord("Control+a"), "rawKeyDown").text, undefined);
    assert.deepEqual(keyEventParams(parseChord("Control+a"), "rawKeyDown").commands, ["selectAll"]);
  });
});

/* CdpPage over a fake transport ------------------------------------------------ */

type Handler = (params: Record<string, unknown>) => unknown;

class FakeTransport implements CdpTransport {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  handlers = new Map<string, Handler>();
  private listeners = new Map<string, Set<(p: unknown) => void>>();
  renderableCalls = 0;

  constructor() {
    this.handlers.set("Runtime.evaluate", () => ({ result: { value: { url: "https://shop.test/", title: "Shop" } } }));
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) return {} as T;
    const out = handler(params);
    if (out instanceof Error) throw out;
    return out as T;
  }

  on(method: string, handler: (p: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(handler);
    this.listeners.set(method, set);
    return () => set.delete(handler);
  }

  emit(method: string, params: unknown): void {
    for (const h of this.listeners.get(method) ?? []) h(params);
  }

  keyboardCalls = 0;
  async ensureRenderable(opts?: { keyboard?: boolean }): Promise<void> {
    this.renderableCalls++;
    if (opts?.keyboard) this.keyboardCalls++;
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
  last(method: string): Record<string, unknown> | undefined {
    return [...this.calls].reverse().find((c) => c.method === method)?.params;
  }
}

async function readyPage(): Promise<{ page: CdpPage; t: FakeTransport }> {
  const t = new FakeTransport();
  t.handlers.set("Accessibility.getFullAXTree", () => ({ nodes: sampleTree() }));
  const page = new CdpPage(t);
  await page.init();
  await page.snapshot(); // assigns refs: Email=e1, Continue=e2, Help=e3
  return { page, t };
}

const box = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y + h, x, y + h];

describe("CdpPage", () => {
  it("clicks the center of the element's largest box with real mouse events", async () => {
    const { page, t } = await readyPage();
    t.handlers.set("DOM.getContentQuads", () => ({ quads: [box(0, 0, 2, 2), box(100, 200, 40, 20)] }));
    const result = await page.click({ ref: "e2" });
    assert.match(result, /Clicked ref e2/);
    const mouse = t.calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params);
    assert.deepEqual(
      mouse.map((m) => m.type),
      ["mouseMoved", "mousePressed", "mouseReleased"],
    );
    assert.equal(mouse[1]?.x, 120);
    assert.equal(mouse[1]?.y, 210);
    assert.equal(mouse[1]?.clickCount, 1);
    assert.equal(t.count("DOM.scrollIntoViewIfNeeded"), 1);
    assert.ok(t.renderableCalls > 0, "input first makes the page renderable (background tabs)");
  });

  it("supports double click, right button and modifiers", async () => {
    const { page, t } = await readyPage();
    t.handlers.set("DOM.getContentQuads", () => ({ quads: [box(10, 10, 10, 10)] }));
    await page.click({ ref: "e2" }, { count: 2, button: "right", modifiers: ["shift", "ctrl"] });
    const pressed = t.calls.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed").map((c) => c.params);
    assert.deepEqual(
      pressed.map((m) => m.clickCount),
      [1, 2],
    );
    assert.equal(pressed[0]?.button, "right");
    assert.equal(pressed[0]?.modifiers, 8 | 2);
  });

  it("turns a vanished node into a clear stale-ref error", async () => {
    const { page, t } = await readyPage();
    t.handlers.set("DOM.getContentQuads", () => new Error("Could not find node with given id"));
    await assert.rejects(page.click({ ref: "e2" }), /Ref "e2" is stale.*fresh snapshot/s);
    await assert.rejects(page.click({ ref: "e99" }), /Unknown ref "e99"/);
  });

  it("resolves a CSS selector to a ref that works like any snapshot ref", async () => {
    const { page, t } = await readyPage();
    t.handlers.set("DOM.getDocument", () => ({ root: { nodeId: 1 } }));
    t.handlers.set("DOM.querySelector", () => ({ nodeId: 7 }));
    t.handlers.set("DOM.describeNode", () => ({ node: { backendNodeId: 50, nodeName: "BUTTON" } }));
    t.handlers.set("DOM.getContentQuads", () => ({ quads: [box(0, 0, 20, 20)] }));
    const ref = await page.refForSelector("#go");
    assert.equal(ref, "e2", "the backend node is already known from the snapshot, so its ref is reused");
    assert.equal(t.last("DOM.querySelector")?.selector, "#go");
    assert.match(await page.click({ ref }), /Clicked ref e2/);

    t.handlers.set("DOM.describeNode", () => ({ node: { backendNodeId: 999, nodeName: "A" } }));
    const fresh = await page.refForSelector("a.new");
    assert.match(fresh, /^e\d+$/);
    assert.notEqual(fresh, "e2");
  });

  it("says plainly when a selector matches nothing or is invalid", async () => {
    const { page, t } = await readyPage();
    t.handlers.set("DOM.getDocument", () => ({ root: { nodeId: 1 } }));
    t.handlers.set("DOM.querySelector", () => ({ nodeId: 0 }));
    await assert.rejects(page.refForSelector(".missing"), /no element matches \.missing/);

    t.handlers.set("DOM.querySelector", () => new Error("DOM.querySelector: '[[' is not a valid selector."));
    await assert.rejects(page.refForSelector("[["), /invalid selector \[\[/);
  });

  it("does not touch the DOM for a selector while a dialog blocks the page", async () => {
    const { page, t } = await readyPage();
    t.emit("Page.javascriptDialogOpening", { type: "alert", message: "hi", defaultPrompt: "" });
    const before = t.count("DOM.getDocument");
    await assert.rejects(page.refForSelector("#go"), /alert dialog is open/);
    assert.equal(t.count("DOM.getDocument"), before);
  });

  it("names the host's own snapshot tool in unknown-ref errors", async () => {
    const t = new FakeTransport();
    t.handlers.set("Accessibility.getFullAXTree", () => ({ nodes: sampleTree() }));
    const page = new CdpPage(t, { snapshotTool: "browser_snapshot" });
    await page.init();
    await assert.rejects(page.click({ ref: "e9" }), /Refs come from browser_snapshot/);
    const { page: chromePage } = await readyPage();
    await assert.rejects(chromePage.click({ ref: "e9" }), /Refs come from chrome_snapshot/);
  });

  it("refuses elements with no visible box", async () => {
    const { page, t } = await readyPage();
    t.handlers.set("DOM.getContentQuads", () => ({ quads: [] }));
    await assert.rejects(page.hover({ ref: "e1" }), /no visible box/);
  });

  it("clears refs after a top-level navigation but not a subframe one", async () => {
    const { page, t } = await readyPage();
    t.emit("Page.frameNavigated", { frame: { parentId: "main" } });
    t.handlers.set("DOM.getContentQuads", () => ({ quads: [box(0, 0, 10, 10)] }));
    await page.click({ ref: "e2" });
    t.emit("Page.frameNavigated", { frame: {} });
    await assert.rejects(page.click({ ref: "e2" }), /Unknown ref/);
  });

  it("types with insertText and presses key chords as modifier down, key, key up, modifier up", async () => {
    const { page, t } = await readyPage();
    await page.type("hello", "e1", true);
    assert.equal(t.last("DOM.focus")?.backendNodeId, 40);
    assert.equal(t.last("Input.insertText")?.text, "hello");

    t.calls.length = 0;
    await page.press("Control+A");
    const keys = t.calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => `${String(c.params.type)}:${String(c.params.key)}`);
    assert.deepEqual(keys, ["rawKeyDown:Control", "rawKeyDown:a", "keyUp:a", "keyUp:Control"]);
    assert.deepEqual(t.calls.find((c) => c.params.key === "a")?.params.commands, ["selectAll"]);
  });

  it("fill selects existing content and inserts the new value, refusing checkboxes", async () => {
    const { page, t } = await readyPage();
    t.handlers.set("DOM.resolveNode", () => ({ object: { objectId: "obj-1" } }));
    t.handlers.set("Runtime.callFunctionOn", () => ({ result: { value: "text" } }));
    const result = await page.fill("e1", "me@example.com");
    assert.match(result, /Filled e1/);
    assert.equal(t.last("Input.insertText")?.text, "me@example.com");

    t.handlers.set("Runtime.callFunctionOn", () => ({ result: { value: "checkbox" } }));
    await assert.rejects(page.fill("e1", "x"), /use click instead of fill/);
  });

  it("asks for keyboard readiness only for key and text input", async () => {
    const { page, t } = await readyPage();
    t.handlers.set("DOM.getContentQuads", () => ({ quads: [box(0, 0, 10, 10)] }));
    t.handlers.set("DOM.resolveNode", () => ({ object: { objectId: "obj-1" } }));
    t.handlers.set("Runtime.callFunctionOn", () => ({ result: { value: "text" } }));
    await page.click({ ref: "e2" });
    await page.hover({ ref: "e2" });
    assert.equal(t.keyboardCalls, 0, "pointer input does not need to take keyboard focus");
    await page.press("Enter");
    await page.type("hi");
    await page.fill("e1", "x");
    assert.equal(t.keyboardCalls, 3);
  });

  it("retries a dropped fill with a click, and never reports an empty field as filled", async () => {
    const { page, t } = await readyPage();
    t.handlers.set("DOM.getContentQuads", () => ({ quads: [box(0, 0, 10, 10)] }));
    t.handlers.set("DOM.resolveNode", () => ({ object: { objectId: "obj-1" } }));
    let inserts = 0;
    t.handlers.set("Input.insertText", () => {
      inserts++;
      return {};
    });
    // The page only accepts text once it has been clicked (it did not hold focus before).
    t.handlers.set("Runtime.callFunctionOn", (p) => {
      if (String(p.functionDeclaration).includes("select")) return { result: { value: "text" } };
      return { result: { value: t.count("Input.dispatchMouseEvent") > 0 && inserts > 1 ? "me@example.com" : "" } };
    });
    assert.match(await page.fill("e1", "me@example.com"), /Filled e1/);
    assert.equal(inserts, 2);
    assert.equal(t.count("Input.dispatchMouseEvent") > 0, true, "the retry clicks the field to focus it");

    t.handlers.set("Runtime.callFunctionOn", (p) => ({ result: { value: String(p.functionDeclaration).includes("select") ? "text" : "" } }));
    await assert.rejects(page.fill("e1", "again"), /Typed text did not reach e1; the field is still empty/);
  });

  it("scrolls with the wheel and reports where the page settled", async () => {
    const { page, t } = await readyPage();
    let y = 0;
    t.handlers.set("Input.dispatchMouseEvent", (p) => {
      if (p.type === "mouseWheel") y += Number(p.deltaY);
      return {};
    });
    t.handlers.set("Runtime.evaluate", (p) => ({ result: { value: String(p.expression).includes("scrollBy") ? "fallback" : `${y},0` } }));
    assert.equal(await page.scroll({ deltaY: 400 }), "Scrolled by (0, 400); page is now at y,x = 400,0");
    assert.equal(t.calls.filter((c) => String(c.params.expression).includes("scrollBy({")).length, 0, "no direct scroll when the wheel worked");
    const wheel = t.last("Input.dispatchMouseEvent");
    assert.deepEqual([wheel?.x, wheel?.y], [400, 300], "wheel goes to the middle of the viewport by default");
  });

  it("scrolls the container directly when the page ignores wheel input", async () => {
    const { page, t } = await readyPage();
    let y = 0;
    t.handlers.set("Runtime.evaluate", (p) => {
      const expression = String(p.expression);
      if (expression.includes("scrollBy({")) y += Number(/top: (-?\d+)/.exec(expression)?.[1]);
      return { result: { value: `${y},0` } };
    });
    assert.equal(await page.scroll({ deltaY: 250 }), "Scrolled by (0, 250); page is now at y,x = 250,0");
    assert.equal(t.calls.filter((c) => String(c.params.expression).includes("scrollBy({")).length, 1);
  });

  it("drives native HTML5 drag-and-drop by replaying the intercepted drag as drag events", async () => {
    const { page, t } = await readyPage();
    const payload = { items: [{ mimeType: "text/plain", data: "x" }], dragOperationsMask: 1 };
    t.handlers.set("Input.dispatchMouseEvent", (p) => {
      if (p.type === "mouseMoved" && p.buttons === 1) t.emit("Input.dragIntercepted", { data: payload });
      return {};
    });
    assert.match(await page.drag({ x: 10, y: 10 }, { x: 90, y: 50 }), /native drag-and-drop/);
    const enabled = t.calls.filter((c) => c.method === "Input.setInterceptDrags").map((c) => c.params.enabled);
    assert.deepEqual(enabled, [true, false], "interception is always switched back off");
    const dnd = t.calls.filter((c) => c.method === "Input.dispatchDragEvent");
    assert.deepEqual(dnd.map((c) => c.params.type), ["dragEnter", "dragOver", "drop"]);
    assert.deepEqual([dnd[2]?.params.x, dnd[2]?.params.y, dnd[2]?.params.data], [90, 50, payload]);
    const order = t.calls.map((c) => (c.method === "Input.dispatchMouseEvent" ? String(c.params.type) : c.method));
    assert.ok(order.lastIndexOf("Input.dispatchDragEvent") < order.lastIndexOf("mouseReleased"), "the drop happens before the button is released");
  });

  it("leaves plain mouse drags alone and still releases interception when input fails", async () => {
    const { page, t } = await readyPage();
    await page.drag({ x: 1, y: 1 }, { x: 40, y: 40 });
    assert.equal(t.count("Input.dispatchDragEvent"), 0);
    assert.equal(t.last("Input.setInterceptDrags")?.enabled, false);

    t.handlers.set("Input.dispatchMouseEvent", (p) => (p.type === "mousePressed" ? new Error("target closed") : {}));
    await assert.rejects(page.drag({ x: 1, y: 1 }, { x: 2, y: 2 }), /target closed/);
    assert.equal(t.last("Input.setInterceptDrags")?.enabled, false);
  });

  it("reports an open dialog instead of hanging, and blocks other actions until handled", async () => {
    const { page, t } = await readyPage();
    t.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Delete everything?", defaultPrompt: "" });
    assert.match(await page.snapshot(), /blocked by a JavaScript confirm dialog.*Delete everything\?/s);
    await assert.rejects(page.click({ x: 1, y: 1 }), /confirm dialog is open/);
    await assert.rejects(page.navigate("https://x.test"), /dialog is open/);
    const before = t.count("Runtime.evaluate");
    await page.snapshot();
    assert.equal(t.count("Runtime.evaluate"), before, "snapshot must not evaluate while a dialog blocks the page");

    assert.match(await page.handleDialog(false), /Dismissed confirm dialog/);
    assert.equal(t.last("Page.handleJavaScriptDialog")?.accept, false);
    t.emit("Page.javascriptDialogClosed", {});
    await assert.rejects(page.handleDialog(true), /No JavaScript dialog is open/);
  });

  it("returns as soon as a click opens a dialog instead of waiting for Chrome to release the event", async () => {
    const { page, t } = await readyPage();
    t.handlers.set("DOM.getContentQuads", () => ({ quads: [box(0, 0, 10, 10)] }));
    // Chrome holds the mouseReleased reply until the alert is closed.
    t.handlers.set("Input.dispatchMouseEvent", (params) => {
      if (params.type !== "mouseReleased") return {};
      setTimeout(() => t.emit("Page.javascriptDialogOpening", { type: "alert", message: "hi" }), 20);
      return new Promise(() => undefined);
    });
    const started = Date.now();
    await page.click({ ref: "e2" }, { count: 2 });
    assert.ok(Date.now() - started < 1000, "must not wait for the dialog to close");
    assert.equal(page.pendingDialog()?.message, "hi");
    assert.equal(t.count("Input.dispatchMouseEvent"), 3, "no further input is sent behind the open dialog");
  });

  it("reports a dialog opened by evaluate() instead of hanging", async () => {
    const { page, t } = await readyPage();
    t.handlers.set("Runtime.evaluate", () => {
      setTimeout(() => t.emit("Page.javascriptDialogOpening", { type: "confirm", message: "sure?" }), 20);
      return new Promise(() => undefined);
    });
    assert.match(await page.evaluate("confirm('sure?')"), /opened a JavaScript confirm dialog.*sure\?.*dialog tool/s);
  });

  it("retries a stalled screenshot once and then points at the snapshot tool", async () => {
    const { page, t } = await readyPage();
    let attempts = 0;
    t.handlers.set("Page.captureScreenshot", () => {
      attempts++;
      return attempts === 1 ? new Error("timed out") : { data: "UE5H" };
    });
    const shot = await page.screenshot();
    assert.equal(shot.base64, "UE5H");
    assert.equal(attempts, 2);

    t.handlers.set("Page.captureScreenshot", () => new Error("timed out"));
    await assert.rejects(page.screenshot(), /use the snapshot tool to read the page/);
  });

  it("collects console, network and failed requests", async () => {
    const { page, t } = await readyPage();
    t.emit("Runtime.consoleAPICalled", { type: "warning", args: [{ value: "careful" }, { description: "Error: boom" }] });
    t.emit("Network.requestWillBeSent", { requestId: "1", request: { url: "https://shop.test/api", method: "POST" } });
    t.emit("Network.responseReceived", { requestId: "1", response: { status: 500, url: "https://shop.test/api" } });
    t.emit("Network.requestWillBeSent", { requestId: "2", request: { url: "https://shop.test/x.png", method: "GET" } });
    t.emit("Network.loadingFailed", { requestId: "2", errorText: "net::ERR_BLOCKED" });
    assert.match(page.consoleTail(10), /\[warn\] careful Error: boom/);
    assert.match(page.networkTail(10), /500 POST https:\/\/shop\.test\/api/);
    const failed = page.networkTail(10, true);
    assert.match(failed, /FAILED GET https:\/\/shop\.test\/x\.png/);
    assert.match(failed, /500 POST/);
  });

  it("waits for text with a clear timeout error", async () => {
    const { page, t } = await readyPage();
    let polls = 0;
    t.handlers.set("Runtime.evaluate", () => ({ result: { value: ++polls >= 3 } }));
    assert.match(await page.waitFor({ text: "Welcome" }), /Text appeared/);
    t.handlers.set("Runtime.evaluate", () => ({ result: { value: false } }));
    await assert.rejects(page.waitFor({ text: "Never", timeoutMs: 400 }), /Timed out.*"Never"/);
  });
});
