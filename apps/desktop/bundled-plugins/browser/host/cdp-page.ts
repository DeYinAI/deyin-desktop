import { MODIFIER_BITS, keyEventParams, modifierEventParams, parseChord } from "./cdp-keys.js";

/**
 * Transport-agnostic page automation over the Chrome DevTools Protocol.
 *
 * One `CdpPage` drives one tab. The transport is the only thing that differs
 * between the user's real Chrome (chrome.debugger relayed by the extension) and
 * the in-app webview (`webContents.debugger`), so both get the same
 * accessibility-tree snapshot, stable refs and trusted input events
 * (`Input.dispatch*`) instead of `el.click()` and DOM mutation.
 */

export interface CdpTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
  /** Subscribe to one CDP event for this page. Returns an unsubscribe function. */
  on(method: string, handler: (params: unknown) => void): () => void;
  /**
   * Make sure the page can render and take input right now (e.g. re-apply
   * focus emulation for a hidden tab). Throws a clear error when it cannot.
   * `keyboard` is set for key and text input, which an embedded page only
   * accepts once it actually holds focus.
   */
  ensureRenderable?(opts?: { keyboard?: boolean }): Promise<void>;
}

/* Accessibility tree ----------------------------------------------------------- */

interface AxValue {
  type?: string;
  value?: unknown;
}
interface AxProperty {
  name: string;
  value: AxValue;
}
export interface AxNode {
  nodeId: string;
  parentId?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: AxProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface RefEntry {
  backendNodeId: number;
  role: string;
  name: string;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "treeitem",
  "PopUpButton",
  "DisclosureTriangle",
  "ColorWell",
  "listbox",
  "textarea",
]);

/** Pure-structure roles that add noise without meaning unless they carry a name. */
const SKIP_ROLES = new Set(["generic", "none", "presentation", "paragraph", "InlineTextBox", "LineBreak", "Section"]);

const TEXT_ROLES = new Set(["StaticText", "text"]);

/** How long drag waits after the last move for Chrome to report a native drag. */
const DRAG_INTERCEPT_WAIT_MS = 150;
/** Scroll polling: how long to wait for a wheel event to move anything, and for smooth scrolling to settle. */
const SCROLL_POLL_MS = 80;
const SCROLL_START_POLLS = 5;
const SCROLL_SETTLE_POLLS = 6;
const MAX_NAME_CHARS = 120;
const DEFAULT_MAX_CHARS = 30_000;

function str(v: AxValue | undefined): string {
  return typeof v?.value === "string" ? v.value : typeof v?.value === "number" ? String(v.value) : "";
}

function clip(s: string, max = MAX_NAME_CHARS): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function prop(node: AxNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

function describeState(node: AxNode): string[] {
  const out: string[] = [];
  const checked = prop(node, "checked");
  if (checked === true || checked === "true") out.push("checked");
  else if (checked === "mixed") out.push("mixed");
  if (prop(node, "disabled") === true) out.push("disabled");
  const expanded = prop(node, "expanded");
  if (expanded === true) out.push("expanded");
  else if (expanded === false) out.push("collapsed");
  if (prop(node, "selected") === true) out.push("selected");
  const pressed = prop(node, "pressed");
  if (pressed === true || pressed === "true") out.push("pressed");
  if (prop(node, "required") === true) out.push("required");
  if (prop(node, "readonly") === true) out.push("readonly");
  if (prop(node, "focused") === true) out.push("focused");
  if (prop(node, "invalid") === "true" || prop(node, "invalid") === true) out.push("invalid");
  const level = prop(node, "level");
  if (typeof level === "number") out.push(`level=${level}`);
  return out;
}

interface Line {
  depth: number;
  text: string;
  parent: number;
}

export interface RenderOptions {
  /** Re-root the output at the node with this backend id. */
  rootBackendId?: number;
  /** Keep only lines containing this text (plus their ancestors). */
  query?: string;
  maxChars?: number;
}

export interface RenderResult {
  text: string;
  truncated: boolean;
}

/**
 * Render an AX node list as a compact outline. `assignRef` hands out stable
 * refs: the same backend node keeps the same ref across snapshots.
 */
export function renderAxTree(
  nodes: AxNode[],
  assignRef: (entry: RefEntry) => string,
  opts: RenderOptions = {},
): RenderResult {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines: Line[] = [];

  const roots: AxNode[] = [];
  if (opts.rootBackendId !== undefined) {
    const root = nodes.find((n) => n.backendDOMNodeId === opts.rootBackendId);
    if (root) roots.push(root);
  } else {
    for (const n of nodes) if (!n.parentId || !byId.has(n.parentId)) roots.push(n);
  }

  const visit = (node: AxNode, depth: number, parentLine: number, parentName: string): void => {
    const children = (node.childIds ?? []).map((id) => byId.get(id)).filter((n): n is AxNode => n !== undefined);
    const walkChildren = (d: number, parent: number, pName: string): void => {
      for (const child of children) visit(child, d, parent, pName);
    };

    if (node.ignored) return walkChildren(depth, parentLine, parentName);

    const role = str(node.role) || "generic";
    const name = clip(str(node.name));

    if (TEXT_ROLES.has(role)) {
      if (!name || parentName.includes(name)) return;
      lines.push({ depth, text: `- text "${name}"`, parent: parentLine });
      return;
    }
    if (role === "RootWebArea") {
      const idx = lines.push({ depth, text: `- page${name ? ` "${name}"` : ""}`, parent: parentLine }) - 1;
      return walkChildren(depth + 1, idx, name);
    }
    if (SKIP_ROLES.has(role) && !name) return walkChildren(depth, parentLine, parentName);

    const interactive = INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId !== undefined;
    let text = `- ${role}`;
    if (name) text += ` "${name}"`;
    const value = clip(str(node.value), 80);
    if (value && interactive) text += ` value="${value}"`;
    const state = describeState(node);
    if (state.length) text += ` [${state.join(", ")}]`;
    const url = prop(node, "url");
    if (role === "link" && typeof url === "string" && url) text += ` → ${clip(url, 140)}`;
    if (interactive && node.backendDOMNodeId !== undefined) {
      const entry: RefEntry = { backendNodeId: node.backendDOMNodeId, role, name };
      text += ` [ref=${assignRef(entry)}]`;
    }
    const idx = lines.push({ depth, text, parent: parentLine }) - 1;
    walkChildren(depth + 1, idx, name || parentName);
  };

  for (const root of roots) visit(root, 0, -1, "");

  let selected = lines.map((_, i) => i);
  const query = opts.query?.trim().toLowerCase();
  if (query) {
    const keep = new Set<number>();
    lines.forEach((line, i) => {
      if (!line.text.toLowerCase().includes(query)) return;
      for (let p = i; p >= 0 && !keep.has(p); p = lines[p]?.parent ?? -1) keep.add(p);
    });
    selected = [...keep].sort((a, b) => a - b);
  }

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const out: string[] = [];
  let used = 0;
  let truncated = false;
  for (const i of selected) {
    const line = lines[i];
    if (!line) continue;
    const rendered = `${"  ".repeat(line.depth)}${line.text}`;
    if (used + rendered.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    out.push(rendered);
    used += rendered.length + 1;
  }
  if (truncated) out.push("… (truncated: pass `query` or a `ref` to narrow the snapshot)");
  if (query && selected.length === 0) out.push(`(no elements matching "${opts.query}")`);
  return { text: out.join("\n"), truncated };
}

/* Logs ------------------------------------------------------------------------- */

class RingLog {
  private lines: string[] = [];
  constructor(private readonly cap: number) {}
  push(line: string): void {
    this.lines.push(`[${new Date().toISOString().slice(11, 23)}] ${line}`);
    if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
  }
  tail(n: number): string[] {
    return this.lines.slice(-Math.max(1, Math.min(n, this.cap)));
  }
  get size(): number {
    return this.lines.length;
  }
}

export interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt: string;
}

/* Page ------------------------------------------------------------------------- */

export interface ClickOptions {
  button?: "left" | "right" | "middle";
  count?: number;
  modifiers?: Array<"alt" | "ctrl" | "meta" | "shift">;
}

export type PointTarget = { ref: string } | { x: number; y: number };

export interface ScreenshotOptions {
  ref?: string;
  fullPage?: boolean;
}

export interface ScreenshotResult {
  base64: string;
  mediaType: "image/png";
}

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

interface EvalResponse {
  result: RemoteObject;
  exceptionDetails?: { text?: string; exception?: RemoteObject };
}

const STALE_NODE = /(could not find node|no node with given id|node with given id does not belong|node is detached)/i;

export interface CdpPageOptions {
  /** Name of the tool that produces refs, quoted in "unknown ref" errors. */
  snapshotTool?: string;
}

export class CdpPage {
  private readonly refs = new Map<string, RefEntry>();
  private readonly refByBackend = new Map<number, string>();
  private nextRef = 1;
  private readonly consoleLog = new RingLog(300);
  private readonly networkLog = new RingLog(300);
  private readonly requests = new Map<string, { method: string; url: string }>();
  private dialog: DialogInfo | null = null;
  private readonly dialogWaiters = new Set<() => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private ready: Promise<void> | null = null;

  private readonly snapshotTool: string;

  constructor(
    private readonly t: CdpTransport,
    opts: CdpPageOptions = {},
  ) {
    this.snapshotTool = opts.snapshotTool ?? "chrome_snapshot";
  }

  /** Enable the CDP domains and start collecting events. Idempotent. */
  init(): Promise<void> {
    this.ready ??= this.setup();
    return this.ready;
  }

  private async setup(): Promise<void> {
    this.unsubscribe.push(
      this.t.on("Runtime.consoleAPICalled", (p) => {
        const e = p as { type?: string; args?: RemoteObject[] };
        const text = (e.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type ?? ""))).join(" ");
        this.consoleLog.push(`[${e.type === "warning" ? "warn" : (e.type ?? "log")}] ${text}`);
      }),
      this.t.on("Runtime.exceptionThrown", (p) => {
        const e = p as { exceptionDetails?: { text?: string; exception?: RemoteObject } };
        this.consoleLog.push(`[error] ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text ?? "Uncaught exception"}`);
      }),
      this.t.on("Log.entryAdded", (p) => {
        const e = p as { entry?: { level?: string; text?: string; url?: string } };
        this.consoleLog.push(`[${e.entry?.level ?? "log"}] ${e.entry?.text ?? ""}${e.entry?.url ? ` (${e.entry.url})` : ""}`);
      }),
      this.t.on("Network.requestWillBeSent", (p) => {
        const e = p as { requestId?: string; request?: { url?: string; method?: string } };
        if (e.requestId && e.request?.url) this.requests.set(e.requestId, { method: e.request.method ?? "GET", url: e.request.url });
        if (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value as string);
      }),
      this.t.on("Network.responseReceived", (p) => {
        const e = p as { requestId?: string; response?: { status?: number; url?: string } };
        const req = e.requestId ? this.requests.get(e.requestId) : undefined;
        this.networkLog.push(`${e.response?.status ?? "?"} ${req?.method ?? "GET"} ${e.response?.url ?? req?.url ?? ""}`);
      }),
      this.t.on("Network.loadingFailed", (p) => {
        const e = p as { requestId?: string; errorText?: string; canceled?: boolean };
        if (e.canceled) return;
        const req = e.requestId ? this.requests.get(e.requestId) : undefined;
        this.networkLog.push(`FAILED ${req?.method ?? "GET"} ${req?.url ?? ""} (${e.errorText ?? "error"})`);
      }),
      this.t.on("Page.javascriptDialogOpening", (p) => {
        const e = p as { type?: string; message?: string; defaultPrompt?: string };
        this.dialog = { type: e.type ?? "alert", message: e.message ?? "", defaultPrompt: e.defaultPrompt ?? "" };
        for (const wake of [...this.dialogWaiters]) wake();
      }),
      this.t.on("Page.javascriptDialogClosed", () => {
        this.dialog = null;
      }),
      this.t.on("Page.frameNavigated", (p) => {
        const e = p as { frame?: { parentId?: string } };
        // A top-level navigation invalidates every node reference.
        if (!e.frame?.parentId) this.clearRefs();
      }),
    );
    await Promise.all(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].map((m) => this.t.send(m)));
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.clearRefs();
  }

  private clearRefs(): void {
    this.refs.clear();
    this.refByBackend.clear();
  }

  private assignRef = (entry: RefEntry): string => {
    const existing = this.refByBackend.get(entry.backendNodeId);
    if (existing) {
      this.refs.set(existing, entry);
      return existing;
    }
    const ref = `e${this.nextRef++}`;
    this.refs.set(ref, entry);
    this.refByBackend.set(entry.backendNodeId, ref);
    return ref;
  };

  private entry(ref: string): RefEntry {
    const entry = this.refs.get(ref);
    if (!entry) throw new Error(`Unknown ref "${ref}". Refs come from ${this.snapshotTool}; take a fresh snapshot.`);
    return entry;
  }

  private staleError(ref: string): Error {
    return new Error(`Ref "${ref}" is stale (the element left the page or the page changed). Take a fresh snapshot.`);
  }

  private async call<T>(ref: string | null, method: string, params: Record<string, unknown>): Promise<T> {
    try {
      return await this.t.send<T>(method, params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (ref && STALE_NODE.test(message)) throw this.staleError(ref);
      throw err;
    }
  }

  /**
   * Wait for `promise`, but give up as soon as a JS dialog opens. Chrome holds
   * back the reply to an input event (or evaluate) that triggers alert() until
   * the dialog is closed, which would otherwise stall until the timeout.
   */
  private async raceDialog<T>(promise: Promise<T>): Promise<T | "dialog"> {
    promise.catch(() => undefined); // abandoned if the dialog wins; the error still surfaces if the call wins
    let wake: () => void = () => undefined;
    const opened = new Promise<"dialog">((resolve) => {
      wake = () => resolve("dialog");
      this.dialogWaiters.add(wake);
    });
    try {
      return await Promise.race([promise, opened]);
    } finally {
      this.dialogWaiters.delete(wake);
    }
  }

  private async input(method: string, params: Record<string, unknown>): Promise<void> {
    // Later steps of a gesture that already opened a dialog would only hang behind it.
    if (this.dialog) return;
    await this.raceDialog(this.t.send(method, params));
  }

  private assertNoDialog(): void {
    if (this.dialog) {
      throw new Error(
        `A JavaScript ${this.dialog.type} dialog is open ("${clip(this.dialog.message, 100)}"). Resolve it with the dialog tool first.`,
      );
    }
  }

  /* Reading ---------------------------------------------------------------- */

  async info(): Promise<{ url: string; title: string }> {
    const r = await this.t.send<EvalResponse>("Runtime.evaluate", {
      expression: "({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    const v = (r.result.value ?? {}) as { url?: string; title?: string };
    return { url: v.url ?? "", title: v.title ?? "" };
  }

  async snapshot(opts: { ref?: string; query?: string; maxChars?: number } = {}): Promise<string> {
    // A page blocked on alert()/confirm() cannot be evaluated; report the dialog instead.
    if (this.dialog) {
      return `The page is blocked by a JavaScript ${this.dialog.type} dialog: ${JSON.stringify(clip(this.dialog.message, 200))}\nResolve it with the dialog tool, then snapshot again.`;
    }
    const { url, title } = await this.info();
    const nodes = await this.collectAxNodes();
    const rootBackendId = opts.ref ? this.entry(opts.ref).backendNodeId : undefined;
    const rendered = renderAxTree(nodes, this.assignRef, {
      ...(rootBackendId !== undefined ? { rootBackendId } : {}),
      ...(opts.query ? { query: opts.query } : {}),
      ...(opts.maxChars ? { maxChars: opts.maxChars } : {}),
    });
    return `Page: ${title || "(untitled)"}\nURL: ${url}\n\n${rendered.text || "(empty accessibility tree)"}`;
  }

  /**
   * The root frame's tree plus its direct child frames. Each child tree is
   * attached under the matching Iframe node (document order); deeper nesting
   * and out-of-process frames are skipped rather than failing the snapshot.
   */
  private async collectAxNodes(): Promise<AxNode[]> {
    const main = await this.t.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", {});
    const nodes = [...main.nodes];
    const iframeNodes = main.nodes.filter((n) => str(n.role) === "Iframe");
    if (iframeNodes.length === 0) return nodes;
    try {
      const tree = await this.t.send<{ frameTree: FrameTreeNode }>("Page.getFrameTree");
      const children = tree.frameTree.childFrames ?? [];
      for (const [i, child] of children.entries()) {
        const owner = iframeNodes[i];
        if (!owner) break;
        try {
          const sub = await this.t.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", { frameId: child.frame.id });
          const subRoot = sub.nodes.find((n) => !n.parentId);
          if (!subRoot) continue;
          nodes.push(...sub.nodes);
          owner.childIds = [...(owner.childIds ?? []), subRoot.nodeId];
        } catch {
          // out-of-process or detached frame
        }
      }
    } catch {
      // frame tree unavailable: main frame only
    }
    return nodes;
  }

  consoleTail(lines: number, level?: string): string {
    let all = this.consoleLog.tail(300);
    if (level) all = all.filter((l) => l.includes(`[${level}]`));
    const shown = all.slice(-Math.max(1, Math.min(lines, 200)));
    return shown.length ? `console (${this.consoleLog.size} captured), last ${shown.length}:\n${shown.join("\n")}` : "No console output captured yet.";
  }

  networkTail(lines: number, failedOnly = false): string {
    let all = this.networkLog.tail(300);
    if (failedOnly) all = all.filter((l) => l.includes("FAILED") || /\] [45]\d\d /.test(l));
    const shown = all.slice(-Math.max(1, Math.min(lines, 200)));
    return shown.length ? `network (${this.networkLog.size} captured), last ${shown.length}:\n${shown.join("\n")}` : "No network activity captured yet.";
  }

  /**
   * Resolve a CSS selector to a ref, so tools that still accept selectors can
   * use the same trusted-input paths as ref-based ones. Matches the first
   * element in the main document (it does not pierce shadow roots or iframes).
   */
  async refForSelector(selector: string): Promise<string> {
    this.assertNoDialog();
    const miss = new Error(`no element matches ${selector}`);
    let nodeId: number;
    try {
      const doc = await this.t.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
      const found = await this.t.send<{ nodeId: number }>("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
      nodeId = found.nodeId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An invalid selector is the caller's mistake; say so rather than surfacing a protocol error.
      // (Chrome words it "DOM Error while querying"; other builds name the selector.)
      if (/not a valid selector|SyntaxError|DOM Error while querying|DOM\.querySelector/i.test(message)) throw new Error(`invalid selector ${selector}`);
      throw err;
    }
    if (!nodeId) throw miss;
    const described = await this.t.send<{ node: { backendNodeId: number; nodeName: string } }>("DOM.describeNode", { nodeId });
    return this.assignRef({ backendNodeId: described.node.backendNodeId, role: described.node.nodeName.toLowerCase(), name: selector });
  }

  /* Navigation ------------------------------------------------------------- */

  async navigate(url: string): Promise<string> {
    this.assertNoDialog();
    const result = await this.t.send<{ errorText?: string }>("Page.navigate", { url });
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    this.clearRefs();
    await this.waitForLoad();
    const { url: finalUrl, title } = await this.info();
    return `Loaded ${finalUrl} — "${title}"`;
  }

  async history(direction: "back" | "forward"): Promise<string> {
    this.assertNoDialog();
    const nav = await this.t.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory");
    const entry = nav.entries[nav.currentIndex + (direction === "back" ? -1 : 1)];
    if (!entry) return `Nothing to go ${direction} to.`;
    await this.t.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    this.clearRefs();
    await this.waitForLoad();
    const { url, title } = await this.info();
    return `Went ${direction} to ${url} — "${title}"`;
  }

  async reload(): Promise<string> {
    this.assertNoDialog();
    await this.t.send("Page.reload", {});
    this.clearRefs();
    await this.waitForLoad();
    const { url, title } = await this.info();
    return `Reloaded ${url} — "${title}"`;
  }

  /** Wait for document.readyState === "complete", but never longer than the timeout. */
  async waitForLoad(timeoutMs = 12_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await sleep(120);
    while (Date.now() < deadline) {
      try {
        const r = await this.t.send<EvalResponse>("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
        if (r.result.value === "complete") return;
      } catch {
        // execution context is being replaced by the navigation; retry
      }
      await sleep(150);
    }
  }

  /* Geometry --------------------------------------------------------------- */

  private async pointFor(target: PointTarget): Promise<{ x: number; y: number }> {
    if ("x" in target) return { x: target.x, y: target.y };
    const { backendNodeId } = this.entry(target.ref);
    try {
      await this.t.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (STALE_NODE.test(message)) throw this.staleError(target.ref);
      // Some nodes cannot be scrolled (e.g. fixed); fall through and use their box.
    }
    const { quads } = await this.call<{ quads: number[][] }>(target.ref, "DOM.getContentQuads", { backendNodeId });
    let best: { x: number; y: number; area: number } | null = null;
    for (const q of quads) {
      if (q.length < 8) continue;
      const xs = [q[0], q[2], q[4], q[6]] as number[];
      const ys = [q[1], q[3], q[5], q[7]] as number[];
      const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
      if (area > (best?.area ?? 0)) best = { x: (xs[0]! + xs[1]! + xs[2]! + xs[3]!) / 4, y: (ys[0]! + ys[1]! + ys[2]! + ys[3]!) / 4, area };
    }
    if (!best) throw new Error(`Ref "${target.ref}" has no visible box (hidden, zero-size or off-screen).`);
    return { x: Math.round(best.x), y: Math.round(best.y) };
  }

  private modifierMask(modifiers: ClickOptions["modifiers"]): number {
    return (modifiers ?? []).reduce((mask, m) => mask | MODIFIER_BITS[m], 0);
  }

  /* Input ------------------------------------------------------------------ */

  async click(target: PointTarget, opts: ClickOptions = {}): Promise<string> {
    this.assertNoDialog();
    await this.t.ensureRenderable?.();
    const { x, y } = await this.pointFor(target);
    const button = opts.button ?? "left";
    const count = Math.max(1, Math.min(opts.count ?? 1, 3));
    const modifiers = this.modifierMask(opts.modifiers);
    await this.input("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    for (let i = 1; i <= count; i++) {
      await this.input("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, modifiers });
      await this.input("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, modifiers });
    }
    const label = "ref" in target ? `ref ${target.ref}` : `(${x}, ${y})`;
    return `${count > 1 ? "Double-clicked" : button === "right" ? "Right-clicked" : "Clicked"} ${label}`;
  }

  async hover(target: PointTarget): Promise<string> {
    this.assertNoDialog();
    await this.t.ensureRenderable?.();
    const { x, y } = await this.pointFor(target);
    await this.input("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    return `Hovered ${"ref" in target ? `ref ${target.ref}` : `(${x}, ${y})`}`;
  }

  async scroll(opts: { ref?: string; deltaX?: number; deltaY?: number }): Promise<string> {
    this.assertNoDialog();
    await this.t.ensureRenderable?.();
    let point: { x: number; y: number };
    if (opts.ref) {
      point = await this.pointFor({ ref: opts.ref });
    } else {
      const metrics = await this.t.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics");
      point = {
        x: Math.round((metrics.cssVisualViewport?.clientWidth ?? 800) / 2),
        y: Math.round((metrics.cssVisualViewport?.clientHeight ?? 600) / 2),
      };
    }
    const deltaX = opts.deltaX ?? 0;
    const deltaY = opts.deltaY ?? 600;
    const before = await this.scrollPosition(point, deltaX, deltaY, false);
    await this.input("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX, deltaY });
    let after = before;
    for (let i = 0; i < SCROLL_START_POLLS && after === before; i++) {
      await sleep(SCROLL_POLL_MS);
      after = await this.scrollPosition(point, deltaX, deltaY, false);
    }
    if (after === before) {
      // A page that is not painting (minimized window, hidden tab) ignores wheel input.
      // Scroll the same container directly rather than reporting a scroll that never happened.
      after = await this.scrollPosition(point, deltaX, deltaY, true);
    } else {
      // Smooth scrolling is still animating; wait for it to settle before reporting.
      for (let i = 0; i < SCROLL_SETTLE_POLLS; i++) {
        await sleep(SCROLL_POLL_MS);
        const next = await this.scrollPosition(point, deltaX, deltaY, false);
        if (next === after) break;
        after = next;
      }
    }
    return `Scrolled by (${deltaX}, ${deltaY}); page is now at y,x = ${after}`;
  }

  /**
   * Scroll offset ("y,x") of the scroll container under a point, optionally
   * scrolling it first. Reading and scrolling resolve the same container.
   */
  private async scrollPosition(point: { x: number; y: number }, dx: number, dy: number, apply: boolean): Promise<string> {
    const r = await this.t.send<EvalResponse>("Runtime.evaluate", {
      expression: `(() => {
        let el = document.elementFromPoint(${point.x}, ${point.y});
        const scrollable = (e) => {
          const s = getComputedStyle(e);
          return /auto|scroll|overlay/.test(s.overflowY + " " + s.overflowX) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth);
        };
        while (el && el !== document.body && el !== document.documentElement && !scrollable(el)) el = el.parentElement;
        const inner = el && el !== document.body && el !== document.documentElement ? el : null;
        ${apply ? `(inner || window).scrollBy({ left: ${dx}, top: ${dy}, behavior: "instant" });` : ""}
        return inner ? Math.round(inner.scrollTop) + "," + Math.round(inner.scrollLeft) : Math.round(window.scrollY) + "," + Math.round(window.scrollX);
      })()`,
      returnByValue: true,
    });
    return String(r.result.value ?? "?");
  }

  async drag(from: PointTarget, to: PointTarget): Promise<string> {
    this.assertNoDialog();
    await this.t.ensureRenderable?.();
    const a = await this.pointFor(from);
    const b = await this.pointFor(to);
    // A native HTML5 drag (draggable=true) is not started by synthetic mouse events:
    // Chrome hands the drag payload back instead, and we replay it as drag events.
    let dragData: unknown = null;
    const stopListening = this.t.on("Input.dragIntercepted", (p) => {
      dragData = (p as { data?: unknown }).data ?? null;
    });
    // Best effort: a host that refuses the method still gets a plain mouse drag.
    const intercepting = await this.t.send("Input.setInterceptDrags", { enabled: true }).then(
      () => true,
      () => false,
    );
    try {
      await this.input("Input.dispatchMouseEvent", { type: "mouseMoved", ...a });
      await this.input("Input.dispatchMouseEvent", { type: "mousePressed", ...a, button: "left", clickCount: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = Math.round(a.x + ((b.x - a.x) * i) / steps);
        const y = Math.round(a.y + ((b.y - a.y) * i) / steps);
        await this.input("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      }
      if (dragData === null) await sleep(DRAG_INTERCEPT_WAIT_MS);
      if (dragData !== null) {
        for (const type of ["dragEnter", "dragOver", "drop"] as const) {
          await this.input("Input.dispatchDragEvent", { type, ...b, data: dragData });
        }
      }
      await this.input("Input.dispatchMouseEvent", { type: "mouseReleased", ...b, button: "left", clickCount: 1 });
    } finally {
      stopListening();
      if (intercepting) await this.t.send("Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
    }
    return `Dragged from (${a.x}, ${a.y}) to (${b.x}, ${b.y})${dragData !== null ? " (native drag-and-drop)" : ""}`;
  }

  private async focusRef(ref: string): Promise<void> {
    const { backendNodeId } = this.entry(ref);
    try {
      await this.t.send("DOM.focus", { backendNodeId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (STALE_NODE.test(message)) throw this.staleError(ref);
      // Not directly focusable: a click focuses it the way a user would.
      await this.click({ ref });
    }
  }

  async press(spec: string): Promise<string> {
    this.assertNoDialog();
    await this.t.ensureRenderable?.({ keyboard: true });
    const chord = parseChord(spec);
    for (const mod of chord.modifierKeys) {
      await this.input("Input.dispatchKeyEvent", modifierEventParams(mod, "rawKeyDown", chord.modifiers));
    }
    const hasText = chord.key.text !== undefined && !(chord.modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.alt | MODIFIER_BITS.meta));
    await this.input("Input.dispatchKeyEvent", keyEventParams(chord, hasText ? "keyDown" : "rawKeyDown"));
    await this.input("Input.dispatchKeyEvent", keyEventParams(chord, "keyUp"));
    for (const mod of [...chord.modifierKeys].reverse()) {
      await this.input("Input.dispatchKeyEvent", modifierEventParams(mod, "keyUp", 0));
    }
    return `Pressed ${spec}`;
  }

  async type(text: string, ref?: string, submit = false): Promise<string> {
    this.assertNoDialog();
    await this.t.ensureRenderable?.({ keyboard: true });
    if (ref) await this.focusRef(ref);
    await this.input("Input.insertText", { text });
    if (submit) await this.press("Enter");
    const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    return `Typed ${JSON.stringify(shown)}${ref ? ` into ${ref}` : ""}${submit ? " and pressed Enter" : ""}`;
  }

  /** Replace a field's content with `value`, firing real input events. */
  async fill(ref: string, value: string, submit = false): Promise<string> {
    this.assertNoDialog();
    await this.t.ensureRenderable?.({ keyboard: true });
    const { backendNodeId } = this.entry(ref);
    await this.focusRef(ref);
    const resolved = await this.call<{ object?: RemoteObject }>(ref, "DOM.resolveNode", { backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw this.staleError(ref);
    // Focuses the field's content for replacement and reports what kind of control it is.
    const selectContent = async (): Promise<string> => {
      const kind = await this.t.send<EvalResponse>("Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        functionDeclaration: `function () {
          const tag = this.tagName ? this.tagName.toLowerCase() : "";
          if (tag === "select") return "select";
          if (tag === "input" && ["checkbox", "radio", "button", "submit", "file"].includes(this.type)) return this.type;
          if (typeof this.select === "function") { this.select(); return "text"; }
          const range = document.createRange(); range.selectNodeContents(this);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          return "editable";
        }`,
      });
      return String(kind.result.value ?? "");
    };
    const k = await selectContent();
    if (k === "select") throw new Error(`Ref ${ref} is a <select>; use the select tool.`);
    if (["checkbox", "radio", "button", "submit", "file"].includes(k)) throw new Error(`Ref ${ref} is a ${k} input; use click instead of fill.`);
    if (value === "") {
      await this.press("Delete");
    } else {
      await this.input("Input.insertText", { text: value });
      // A dropped insert (the page did not hold focus, a handler swallowed it) must not be
      // reported as success. An empty field after a non-empty fill gets one retry that
      // clicks the field first, the way a user would to focus it.
      if ((await this.readField(objectId)) === "") {
        await this.click({ ref });
        await selectContent();
        await this.input("Input.insertText", { text: value });
        if ((await this.readField(objectId)) === "") {
          throw new Error(`Typed text did not reach ${ref}; the field is still empty. Check that it is not disabled or read-only.`);
        }
      }
    }
    if (submit) await this.press("Enter");
    return `Filled ${ref} with ${JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value)}${submit ? " and pressed Enter" : ""}`;
  }

  /** Current text of an input, textarea or contenteditable node. */
  private async readField(objectId: string): Promise<string> {
    const r = await this.t.send<EvalResponse>("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: "function () { return typeof this.value === 'string' ? this.value : (this.textContent || ''); }",
    });
    return String(r.result.value ?? "");
  }

  async select(ref: string, values: string[]): Promise<string> {
    this.assertNoDialog();
    const { backendNodeId } = this.entry(ref);
    const resolved = await this.call<{ object?: RemoteObject }>(ref, "DOM.resolveNode", { backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw this.staleError(ref);
    const r = await this.t.send<EvalResponse>("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      arguments: [{ value: values }],
      functionDeclaration: `function (wanted) {
        if (!this.options) return "ERROR: not a <select>";
        const picked = [];
        for (const opt of Array.from(this.options)) {
          const hit = wanted.includes(opt.value) || wanted.includes(opt.label) || wanted.includes((opt.textContent || "").trim());
          if (this.multiple) opt.selected = hit; else if (hit && picked.length === 0) opt.selected = true;
          if (hit) picked.push(opt.label || opt.value);
        }
        if (picked.length === 0) return "ERROR: no option matched " + JSON.stringify(wanted);
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return "Selected " + picked.join(", ");
      }`,
    });
    const out = String(r.result.value ?? "");
    if (out.startsWith("ERROR")) throw new Error(out.slice(7));
    return out;
  }

  /* Waiting / evaluating / capture ----------------------------------------- */

  async waitFor(opts: { ms?: number; text?: string; textGone?: string; timeoutMs?: number }): Promise<string> {
    this.assertNoDialog();
    const timeout = Math.min(opts.timeoutMs ?? 15_000, 60_000);
    if (!opts.text && !opts.textGone) {
      const ms = Math.min(Math.max(opts.ms ?? 1000, 0), 30_000);
      await sleep(ms);
      return `Waited ${ms}ms`;
    }
    const deadline = Date.now() + timeout;
    const wanted = opts.text ?? opts.textGone ?? "";
    while (Date.now() < deadline) {
      const r = await this.t.send<EvalResponse>("Runtime.evaluate", {
        expression: `document.body ? document.body.innerText.includes(${JSON.stringify(wanted)}) : false`,
        returnByValue: true,
      });
      const present = r.result.value === true;
      if (opts.text ? present : !present) return opts.text ? `Text appeared: ${JSON.stringify(wanted)}` : `Text gone: ${JSON.stringify(wanted)}`;
      await sleep(250);
    }
    throw new Error(`Timed out after ${Math.round(timeout / 1000)}s waiting for text ${opts.text ? "to appear" : "to disappear"}: ${JSON.stringify(wanted)}`);
  }

  async evaluate(expression: string): Promise<string> {
    this.assertNoDialog();
    const r = await this.raceDialog(
      this.t.send<EvalResponse>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }),
    );
    if (r === "dialog") {
      const open = this.dialog as DialogInfo | null;
      return `The expression opened a JavaScript ${open?.type ?? "alert"} dialog (${JSON.stringify(clip(open?.message ?? "", 100))}). Resolve it with the dialog tool.`;
    }
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "Evaluation failed");
    }
    const v = r.result.value;
    const text = v === undefined ? (r.result.description ?? "undefined") : typeof v === "string" ? v : JSON.stringify(v, null, 2);
    return text.length > 12_000 ? `${text.slice(0, 12_000)}\n… (truncated)` : text;
  }

  /**
   * Capture a PNG. Hidden tabs sometimes stall the first capture, so a stalled
   * attempt is retried once before giving up with a pointer to the snapshot tool.
   */
  async screenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    this.assertNoDialog();
    await this.t.ensureRenderable?.();
    const params: Record<string, unknown> = { format: "png" };
    if (opts.fullPage) params.captureBeyondViewport = true;
    if (opts.ref) {
      const { backendNodeId } = this.entry(opts.ref);
      await this.pointFor({ ref: opts.ref });
      const { quads } = await this.call<{ quads: number[][] }>(opts.ref, "DOM.getContentQuads", { backendNodeId });
      const q = quads[0];
      if (!q || q.length < 8) throw new Error(`Ref "${opts.ref}" has no visible box to capture.`);
      const xs = [q[0], q[2], q[4], q[6]] as number[];
      const ys = [q[1], q[3], q[5], q[7]] as number[];
      params.clip = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), scale: 1 };
      params.captureBeyondViewport = true;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await this.t.send<{ data: string }>("Page.captureScreenshot", params, { timeoutMs: 4000 });
        return { base64: r.data, mediaType: "image/png" };
      } catch (err) {
        lastError = err;
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Could not capture a screenshot of this tab (${reason}). Background tabs can stall captures; use the snapshot tool to read the page instead.`,
    );
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<string> {
    const open = this.dialog;
    if (!open) throw new Error("No JavaScript dialog is open.");
    await this.t.send("Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) });
    this.dialog = null;
    return `${accept ? "Accepted" : "Dismissed"} ${open.type} dialog: ${JSON.stringify(clip(open.message, 100))}`;
  }

  pendingDialog(): DialogInfo | null {
    return this.dialog;
  }
}

interface FrameTreeNode {
  frame: { id: string };
  childFrames?: FrameTreeNode[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
