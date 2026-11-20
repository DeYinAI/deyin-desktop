import { once } from "node:events";
import { WebSocket } from "ws";
import type { ChromeBridge } from "../../host/chrome-bridge.js";
import {
  DEYIN_EXTENSION_ID,
  PROTOCOL_VERSION,
  pairingCode,
  sha256Hex,
  type ExtTab,
  type ExtensionMessage,
  type HostMessage,
  type HostOp,
} from "../../host/chrome-protocol.js";

export const GOOD_ORIGIN = `chrome-extension://${DEYIN_EXTENSION_ID}`;

type RequestMessage = Extract<HostMessage, { type: "request" }>;

/** A stand-in for the real extension that speaks the same protocol. */
export class FakeExtension {
  private readonly inbox: HostMessage[] = [];
  private readonly waiters: Array<(m: HostMessage) => void> = [];
  private requestHandler: ((req: RequestMessage) => void) | null = null;
  closed: Promise<number>;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as HostMessage;
      if (message.type === "request" && this.requestHandler) {
        this.requestHandler(message);
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.inbox.push(message);
    });
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  }

  static async connect(port: number, headers: Record<string, string> = { Origin: GOOD_ORIGIN }): Promise<FakeExtension> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { headers });
    await once(ws, "open");
    return new FakeExtension(ws);
  }

  static async connectExpectingFailure(port: number, headers: Record<string, string>): Promise<number> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { headers });
    return await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => undefined);
      ws.on("open", () => resolve(0));
    });
  }

  /** Answer every request through `handler` instead of queueing it for `next()`. */
  onRequest(handler: (req: RequestMessage) => void): void {
    this.requestHandler = handler;
  }

  send(message: ExtensionMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  next<T extends HostMessage["type"]>(type: T): Promise<Extract<HostMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const take = (m: HostMessage) => {
        if (m.type === type) resolve(m as Extract<HostMessage, { type: T }>);
        else reject(new Error(`expected ${type}, got ${m.type}`));
      };
      const queued = this.inbox.shift();
      if (queued) take(queued);
      else this.waiters.push(take);
    });
  }

  hello(browserId = "browser-aaaa-1111", pairToken?: string): void {
    this.send({
      type: "hello",
      v: PROTOCOL_VERSION,
      browserId,
      label: "Test Chrome",
      userAgent: "Chrome/157",
      extVersion: "0.1.0",
      ...(pairToken ? { pairToken } : {}),
    });
  }

  close(): void {
    this.ws.close();
  }
}

export function tab(id: number, extra: Partial<ExtTab> = {}): ExtTab {
  return { id, windowId: 1, title: `t${id}`, url: "https://example.com/", active: false, incognito: false, agent: true, shared: false, attached: false, ...extra };
}

export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Run the full pairing handshake as the extension would; returns the issued token. */
export async function pair(bridge: ChromeBridge, ext: FakeExtension, browserId = "browser-aaaa-1111"): Promise<string> {
  bridge.beginPairing();
  ext.hello(browserId);
  const welcome = await ext.next("welcome");
  if (!welcome.pairing) throw new Error("host did not open pairing");
  const extNonce = "ext-nonce-0123456789abcdef";
  ext.send({ type: "pairingNonce", nonce: extNonce });
  const reveal = await ext.next("pairingReveal");
  if (sha256Hex(reveal.nonce) !== welcome.commit) throw new Error("host revealed a nonce it did not commit to");
  if (bridge.snapshot().pairingCode !== pairingCode(reveal.nonce, extNonce)) throw new Error("pairing code mismatch");
  ext.send({ type: "paired" });
  const { token } = await ext.next("pairToken");
  await waitFor(() => bridge.isConnected(), "connected");
  return token;
}

export type CdpScript = (tabId: number, method: string, params: Record<string, unknown>, browser: ScriptedBrowser) => unknown;

/**
 * An extension that behaves like a small Chrome: it owns tabs, enforces
 * attach, and answers CDP through a script. Lets the host stack run end to end
 * without a real browser.
 */
export class ScriptedBrowser {
  readonly tabs = new Map<number, ExtTab>();
  readonly requests: Array<{ op: HostOp; args: Record<string, unknown> }> = [];
  readonly cdpCalls: Array<{ tabId: number; method: string; params: Record<string, unknown> }> = [];
  private nextTabId = 100;
  stopped = false;
  cdp: CdpScript = defaultCdp;

  constructor(readonly ext: FakeExtension) {
    ext.onRequest((req) => void this.handle(req));
  }

  count(op: HostOp): number {
    return this.requests.filter((r) => r.op === op).length;
  }

  emitTab(kind: "created" | "updated" | "removed" | "shared", id: number): void {
    const t = this.tabs.get(id);
    if (kind === "removed") this.ext.send({ type: "tabEvent", kind, tabId: id });
    else if (t) this.ext.send({ type: "tabEvent", kind, tabId: id, tab: t });
  }

  addSharedTab(url: string): ExtTab {
    const t = tab(this.nextTabId++, { agent: false, shared: true, url, title: "Shared" });
    this.tabs.set(t.id, t);
    this.emitTab("shared", t.id);
    return t;
  }

  setUrl(id: number, url: string): void {
    const t = this.tabs.get(id);
    if (!t) return;
    t.url = url;
    this.emitTab("updated", id);
  }

  private reply(id: number, value: unknown): void {
    this.ext.send({ type: "response", id, ok: true, value });
  }

  private fail(id: number, error: string): void {
    this.ext.send({ type: "response", id, ok: false, error });
  }

  private async handle(req: RequestMessage): Promise<void> {
    this.requests.push({ op: req.op, args: req.args });
    const tabId = typeof req.args.tabId === "number" ? req.args.tabId : -1;
    const known = this.tabs.get(tabId);
    try {
      switch (req.op) {
        case "tabs.list":
          return this.reply(req.id, { tabs: [...this.tabs.values()] });
        case "tabs.create": {
          const url = String(req.args.url ?? "about:blank");
          if (/^chrome:/.test(url)) return this.fail(req.id, "Blocked page type (chrome:).");
          const t = tab(this.nextTabId++, { url, title: url });
          this.tabs.set(t.id, t);
          this.emitTab("created", t.id);
          return this.reply(req.id, { tab: t });
        }
        case "tabs.close":
          if (!known?.agent) return this.fail(req.id, "Only tabs Deyin opened can be closed by Deyin.");
          this.tabs.delete(tabId);
          this.emitTab("removed", tabId);
          return this.reply(req.id, { closed: true });
        case "tabs.reveal":
          return this.reply(req.id, { ok: true });
        case "debugger.attach":
          if (!known) return this.fail(req.id, "That tab is not shared with Deyin.");
          known.attached = true;
          this.emitTab("updated", tabId);
          return this.reply(req.id, { tab: known });
        case "debugger.detach":
          if (known) known.attached = false;
          return this.reply(req.id, { ok: true });
        case "cdp": {
          if (!known?.attached) return this.fail(req.id, "Debugger is not attached to this tab.");
          const method = String(req.args.method);
          const params = (req.args.params ?? {}) as Record<string, unknown>;
          this.cdpCalls.push({ tabId, method, params });
          return this.reply(req.id, { result: await this.cdp(tabId, method, params, this) });
        }
        case "control.stop":
          this.stopped = true;
          for (const t of this.tabs.values()) t.attached = false;
          this.ext.send({ type: "stopped", stopped: true });
          return this.reply(req.id, { stopped: true });
        case "control.resume":
          this.stopped = false;
          this.ext.send({ type: "stopped", stopped: false });
          return this.reply(req.id, { stopped: false });
        default: {
          const _exhaustive: never = req.op;
          return this.fail(req.id, `unknown op ${String(_exhaustive)}`);
        }
      }
    } catch (err) {
      this.fail(req.id, err instanceof Error ? err.message : String(err));
    }
  }
}

/** A small login-page world: AX tree, boxes, and navigation that updates the tab URL. */
const defaultCdp: CdpScript = (tabId, method, params, browser) => {
  const t = browser.tabs.get(tabId);
  switch (method) {
    case "Runtime.evaluate": {
      const expression = String(params.expression ?? "");
      if (expression.includes("readyState")) return { result: { value: "complete" } };
      if (expression.includes("location.href")) return { result: { value: { url: t?.url ?? "", title: t?.title ?? "" } } };
      return { result: { value: `evaluated:${expression}` } };
    }
    case "Page.navigate": {
      browser.setUrl(tabId, String(params.url));
      return {};
    }
    case "Accessibility.getFullAXTree":
      return {
        nodes: [
          { nodeId: "1", role: { value: "RootWebArea" }, name: { value: t?.title ?? "" }, childIds: ["2", "3"] },
          { nodeId: "2", parentId: "1", role: { value: "textbox" }, name: { value: "Email" }, backendDOMNodeId: 40 },
          { nodeId: "3", parentId: "1", role: { value: "button" }, name: { value: "Sign in" }, backendDOMNodeId: 50 },
        ],
      };
    case "DOM.getContentQuads":
      return { quads: [[10, 10, 50, 10, 50, 30, 10, 30]] };
    case "DOM.resolveNode":
      return { object: { objectId: "obj-1" } };
    case "Runtime.callFunctionOn":
      return { result: { value: "text" } };
    case "Page.captureScreenshot":
      return { data: "UE5HREFUQQ==" };
    default:
      return {};
  }
};
