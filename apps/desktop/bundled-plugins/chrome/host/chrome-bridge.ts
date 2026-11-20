import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  DEYIN_EXTENSION_ID,
  EXTENSION_PATH,
  EXTRA_EXTENSION_IDS_ENV,
  PAIRING_WINDOW_MS,
  PROTOCOL_VERSION,
  RELAY_PORTS,
  pairingCode,
  sha256Hex,
  type ExtTab,
  type ExtensionMessage,
  type HostMessage,
  type HostOp,
} from "./chrome-protocol.js";

/**
 * Loopback WebSocket relay between Deyin and the Chrome extension.
 *
 * Trust model (mirrors Browser MCP): the socket is loopback-only with a Host
 * check against DNS rebinding and an Origin check pinned to the extension id,
 * so a web page cannot connect. A local process can still forge an Origin, so
 * a browser must also be *paired*: the user opens a pairing window in Deyin,
 * both sides derive the same six-digit code from commit/reveal nonces, and the
 * user clicks Allow in the extension popup. Pairing issues a token the
 * extension presents on later connects; the host stores only its hash.
 */

const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 20_000;
const HEARTBEAT_DEAD_MS = 60_000;
const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;

export interface PairedBrowser {
  browserId: string;
  label: string;
  tokenHash: string;
  pairedAt: number;
}

interface IdentityFile {
  hostId: string;
  paired: PairedBrowser[];
}

export type BridgeConnectionState = "disconnected" | "pairing" | "connected";

export interface BridgeSnapshot {
  listening: boolean;
  port: number | null;
  connection: BridgeConnectionState;
  pairingCode: string | null;
  pairingOpenUntil: number | null;
  stopped: boolean;
  browser: { label: string; userAgent: string } | null;
  paired: Array<{ browserId: string; label: string; pairedAt: number }>;
  tabs: ExtTab[];
  error?: string;
}

export interface ChromeBridgeOptions {
  /** Directory for identity.json (host id + paired browsers). */
  dataDir: string;
  /** Ports to try in order; tests pass [0] for an ephemeral port. */
  ports?: readonly number[];
  /** Extra accepted extension ids (in addition to the bundled one and the env var). */
  extraExtensionIds?: readonly string[];
  now?: () => number;
}

type Hello = Extract<ExtensionMessage, { type: "hello" }>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type ConnPhase = "awaiting_hello" | "awaiting_nonce" | "awaiting_allow" | "ready";

interface Conn {
  ws: WebSocket;
  phase: ConnPhase;
  hello: Hello | null;
  hostNonce: string;
  code: string | null;
  lastPong: number;
  helloTimer: ReturnType<typeof setTimeout> | null;
  pending: Map<number, Pending>;
}

export class ChromeBridgeError extends Error {
  constructor(
    message: string,
    readonly code: "not_connected" | "stopped" | "timeout" | "extension_error" | "disconnected",
  ) {
    super(message);
    this.name = "ChromeBridgeError";
  }
}

/** Allowed extension origins for the upgrade request. */
export function isAllowedOrigin(origin: string | undefined, allowedIds: ReadonlySet<string>): boolean {
  if (!origin) return false;
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  return Boolean(match?.[1] && allowedIds.has(match[1]));
}

/** DNS-rebinding guard: only literal loopback hosts on our own port. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export class ChromeBridge extends EventEmitter {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port: number | null = null;
  private startError: string | undefined;
  private identity: IdentityFile;
  private readonly identityPath: string;
  private readonly allowedIds: Set<string>;
  private readonly ports: readonly number[];
  private readonly now: () => number;
  private connections = new Set<Conn>();
  private active: Conn | null = null;
  private pairingConn: Conn | null = null;
  private pairingOpenUntil: number | null = null;
  private pairingTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private tabs: ExtTab[] = [];
  private stopped = false;
  private nextRequestId = 1;

  constructor(opts: ChromeBridgeOptions) {
    super();
    this.ports = opts.ports ?? RELAY_PORTS;
    this.now = opts.now ?? Date.now;
    this.identityPath = join(opts.dataDir, "identity.json");
    mkdirSync(opts.dataDir, { recursive: true });
    this.identity = this.loadIdentity();
    const extra = (process.env[EXTRA_EXTENSION_IDS_ENV] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    this.allowedIds = new Set([DEYIN_EXTENSION_ID, ...extra, ...(opts.extraExtensionIds ?? [])]);
  }

  /* Lifecycle ----------------------------------------------------------------- */

  /** Start listening on the first free port. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.server) return;
    let lastError: Error | null = null;
    for (const candidate of this.ports) {
      try {
        const server = await this.listenOn(candidate);
        this.server = server;
        const address = server.address();
        this.port = typeof address === "object" && address ? address.port : candidate;
        this.startError = undefined;
        this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
        this.wss.on("connection", (ws) => this.onConnection(ws));
        this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
        this.heartbeat.unref();
        this.emitStatus();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") break;
      }
    }
    this.startError = `Could not start the Chrome relay: ${lastError?.message ?? "no free port"}`;
    this.emitStatus();
    throw new Error(this.startError);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.closePairingWindow();
    for (const conn of [...this.connections]) {
      this.failPending(conn, new ChromeBridgeError("Chrome relay stopped.", "disconnected"));
      conn.ws.terminate();
    }
    this.connections.clear();
    this.active = null;
    this.tabs = [];
    this.wss?.close();
    this.wss = null;
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.emitStatus();
  }

  private listenOn(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.onHttp(req, res));
      server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        // Runtime errors on an established server must not crash the app.
        server.on("error", () => undefined);
        resolve(server);
      });
    });
  }

  /* Status -------------------------------------------------------------------- */

  snapshot(): BridgeSnapshot {
    // "pairing" covers both waiting for the extension (no code yet) and showing the code.
    const connection: BridgeConnectionState = this.active ? "connected" : this.pairingIsOpen() ? "pairing" : "disconnected";
    return {
      listening: this.server !== null,
      port: this.port,
      connection,
      pairingCode: this.pairingConn?.code ?? null,
      pairingOpenUntil: this.pairingOpenUntil,
      stopped: this.stopped,
      browser: this.active?.hello ? { label: this.active.hello.label, userAgent: this.active.hello.userAgent } : null,
      paired: this.identity.paired.map(({ browserId, label, pairedAt }) => ({ browserId, label, pairedAt })),
      tabs: this.tabs,
      ...(this.startError ? { error: this.startError } : {}),
    };
  }

  isConnected(): boolean {
    return this.active !== null;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  hasPairedBrowser(): boolean {
    return this.identity.paired.length > 0;
  }

  private emitStatus(): void {
    this.emit("status", this.snapshot());
  }

  /* Pairing ------------------------------------------------------------------- */

  /** Open a window in which the next unpaired extension connection may pair. */
  beginPairing(): void {
    this.closePairingWindow();
    this.pairingOpenUntil = this.now() + PAIRING_WINDOW_MS;
    this.pairingTimer = setTimeout(() => {
      this.closePairingWindow();
      this.emitStatus();
    }, PAIRING_WINDOW_MS);
    this.pairingTimer.unref();
    this.emitStatus();
  }

  cancelPairing(): void {
    const pairing = this.pairingConn;
    this.closePairingWindow();
    if (pairing) pairing.ws.close(4002, "pairing cancelled");
    this.emitStatus();
  }

  private closePairingWindow(): void {
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.pairingTimer = null;
    this.pairingOpenUntil = null;
    this.pairingConn = null;
  }

  private pairingIsOpen(): boolean {
    return this.pairingOpenUntil !== null && this.now() < this.pairingOpenUntil;
  }

  forget(browserId: string): void {
    this.identity.paired = this.identity.paired.filter((p) => p.browserId !== browserId);
    this.saveIdentity();
    if (this.active?.hello?.browserId === browserId) this.active.ws.close(4003, "forgotten");
    this.emitStatus();
  }

  /* Requests ------------------------------------------------------------------ */

  /**
   * Send an op to the extension and wait for its response. Rejects with a
   * ChromeBridgeError carrying a user-actionable message when Chrome is not
   * connected, was stopped, or does not answer.
   */
  request<T = unknown>(op: HostOp, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const conn = this.active;
    if (!conn) {
      const hint = this.hasPairedBrowser()
        ? "Open Chrome with the Deyin extension enabled (it reconnects on its own)."
        : "Install the Deyin extension and pair it in Settings → Chrome.";
      return Promise.reject(new ChromeBridgeError(`Chrome is not connected. ${hint}`, "not_connected"));
    }
    if (this.stopped && op !== "control.resume" && op !== "tabs.list") {
      return Promise.reject(
        new ChromeBridgeError("Chrome control is stopped. Resume it in the extension popup or Settings → Chrome.", "stopped"),
      );
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new ChromeBridgeError(`Chrome did not answer ${op} within ${Math.round(timeoutMs / 1000)}s.`, "timeout"));
      }, timeoutMs);
      conn.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.send(conn, { type: "request", id, op, args });
    });
  }

  /** Reject every in-flight request (used by Stop). */
  abortPending(reason: string): void {
    for (const conn of this.connections) this.failPending(conn, new ChromeBridgeError(reason, "stopped"));
  }

  private failPending(conn: Conn, err: Error): void {
    for (const [, pending] of conn.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    conn.pending.clear();
  }

  private send(conn: Conn, message: HostMessage): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(JSON.stringify(message));
  }

  /* HTTP / upgrade ------------------------------------------------------------ */

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    if (!isAllowedHost(req.headers.host, this.port ?? -1) || !isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET" && req.url === "/deyin-chrome/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ app: "deyin", protocol: PROTOCOL_VERSION }));
      return;
    }
    res.writeHead(404).end();
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number) => {
      socket.write(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!this.wss) return reject(503);
    if (req.url !== EXTENSION_PATH) return reject(404);
    if (!isLoopback(req.socket.remoteAddress)) return reject(403);
    if (!isAllowedHost(req.headers.host, this.port ?? -1)) return reject(403);
    if (!isAllowedOrigin(req.headers.origin, this.allowedIds)) return reject(403);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss?.emit("connection", ws, req));
  }

  /* Connection handling ------------------------------------------------------- */

  private onConnection(ws: WebSocket): void {
    const conn: Conn = {
      ws,
      phase: "awaiting_hello",
      hello: null,
      hostNonce: randomBytes(16).toString("hex"),
      code: null,
      lastPong: this.now(),
      helloTimer: null,
      pending: new Map(),
    };
    this.connections.add(conn);
    conn.helloTimer = setTimeout(() => ws.close(4001, "hello timeout"), HELLO_TIMEOUT_MS);
    ws.on("message", (data) => this.onMessage(conn, data));
    ws.on("close", () => this.onClose(conn));
    ws.on("error", () => undefined);
  }

  private onClose(conn: Conn): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    this.connections.delete(conn);
    this.failPending(conn, new ChromeBridgeError("Chrome disconnected.", "disconnected"));
    if (this.pairingConn === conn) this.pairingConn = null;
    if (this.active === conn) {
      this.active = null;
      this.tabs = [];
      this.stopped = false;
      this.emit("disconnected");
    }
    this.emitStatus();
  }

  private onMessage(conn: Conn, raw: RawData): void {
    let message: ExtensionMessage;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") return;
      message = parsed as ExtensionMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case "hello":
        return this.onHello(conn, message);
      case "pairingNonce":
        return this.onPairingNonce(conn, message.nonce);
      case "paired":
        return this.onPaired(conn);
      case "pong":
        conn.lastPong = this.now();
        return;
      case "state":
        if (conn.phase !== "ready") return;
        this.tabs = message.tabs;
        this.stopped = message.stopped;
        this.emitStatus();
        return;
      case "tabEvent":
        if (conn.phase !== "ready") return;
        this.applyTabEvent(message);
        return;
      case "event":
        if (conn.phase !== "ready") return;
        this.emit("cdp", message.tabId, message.method, message.params);
        return;
      case "detached":
        if (conn.phase !== "ready") return;
        this.tabs = this.tabs.map((t) => (t.id === message.tabId ? { ...t, attached: false } : t));
        this.emit("detached", message.tabId, message.reason);
        this.emitStatus();
        return;
      case "stopped":
        if (conn.phase !== "ready") return;
        this.stopped = message.stopped;
        if (message.stopped) this.failPending(conn, new ChromeBridgeError("Chrome control was stopped from the extension.", "stopped"));
        this.emit("stopped", message.stopped);
        this.emitStatus();
        return;
      case "response":
        if (conn.phase !== "ready") return;
        this.onResponse(conn, message);
        return;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
        return;
      }
    }
  }

  private onHello(conn: Conn, hello: Hello): void {
    if (conn.phase !== "awaiting_hello") return;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    if (hello.v !== PROTOCOL_VERSION) {
      this.send(conn, { type: "rejected", reason: "unsupported_protocol" });
      conn.ws.close(4004, "unsupported protocol");
      return;
    }
    if (typeof hello.browserId !== "string" || hello.browserId.length < 8) {
      conn.ws.close(4005, "bad browser id");
      return;
    }
    conn.hello = hello;
    const record = this.identity.paired.find((p) => p.browserId === hello.browserId);

    if (record) {
      if (!hello.pairToken || !constantTimeEqualHex(sha256Hex(hello.pairToken), record.tokenHash)) {
        // Stale or forged token: refuse, and let the extension re-pair if a window is open.
        this.send(conn, { type: "rejected", reason: "token" });
        conn.ws.close(4006, "bad token");
        return;
      }
      this.send(conn, {
        type: "welcome",
        v: PROTOCOL_VERSION,
        hostId: this.identity.hostId,
        commit: sha256Hex(conn.hostNonce),
        paired: true,
        pairing: false,
      });
      this.promote(conn);
      return;
    }

    if (!this.pairingIsOpen()) {
      this.send(conn, {
        type: "welcome",
        v: PROTOCOL_VERSION,
        hostId: this.identity.hostId,
        commit: sha256Hex(conn.hostNonce),
        paired: false,
        pairing: false,
      });
      this.send(conn, { type: "rejected", reason: "not_pairing" });
      conn.ws.close(4007, "not pairing");
      return;
    }

    if (this.pairingConn && this.pairingConn !== conn) this.pairingConn.ws.close(4008, "superseded");
    conn.phase = "awaiting_nonce";
    this.pairingConn = conn;
    this.send(conn, {
      type: "welcome",
      v: PROTOCOL_VERSION,
      hostId: this.identity.hostId,
      commit: sha256Hex(conn.hostNonce),
      paired: false,
      pairing: true,
    });
    this.emitStatus();
  }

  private onPairingNonce(conn: Conn, extensionNonce: string): void {
    if (conn.phase !== "awaiting_nonce" || this.pairingConn !== conn) return;
    if (typeof extensionNonce !== "string" || extensionNonce.length < 16 || extensionNonce.length > 128) return;
    conn.code = pairingCode(conn.hostNonce, extensionNonce);
    conn.phase = "awaiting_allow";
    // Reveal only after the extension committed to its own nonce, so neither side steers the code.
    this.send(conn, { type: "pairingReveal", nonce: conn.hostNonce });
    this.emitStatus();
  }

  private onPaired(conn: Conn): void {
    if (conn.phase !== "awaiting_allow" || this.pairingConn !== conn || !conn.hello) return;
    const token = randomBytes(24).toString("base64url");
    const record: PairedBrowser = {
      browserId: conn.hello.browserId,
      label: conn.hello.label || "Chrome",
      tokenHash: sha256Hex(token),
      pairedAt: this.now(),
    };
    this.identity.paired = [...this.identity.paired.filter((p) => p.browserId !== record.browserId), record];
    this.saveIdentity();
    this.closePairingWindow();
    this.send(conn, { type: "pairToken", token });
    this.promote(conn);
  }

  /** The connection is trusted: make it the active browser. */
  private promote(conn: Conn): void {
    conn.phase = "ready";
    if (this.active && this.active !== conn) {
      const old = this.active;
      this.active = null;
      old.ws.close(4009, "replaced by a newer connection");
    }
    this.active = conn;
    conn.lastPong = this.now();
    this.stopped = false;
    this.tabs = [];
    this.emit("connected");
    this.emitStatus();
  }

  private applyTabEvent(message: Extract<ExtensionMessage, { type: "tabEvent" }>): void {
    if (message.kind === "removed") {
      this.tabs = this.tabs.filter((t) => t.id !== message.tabId);
    } else if (message.tab) {
      const tab = message.tab;
      this.tabs = this.tabs.some((t) => t.id === tab.id) ? this.tabs.map((t) => (t.id === tab.id ? tab : t)) : [...this.tabs, tab];
    }
    this.emit("tab", message.kind, message.tabId, message.tab);
    this.emitStatus();
  }

  private onResponse(conn: Conn, message: Extract<ExtensionMessage, { type: "response" }>): void {
    const pending = conn.pending.get(message.id);
    if (!pending) return;
    conn.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new ChromeBridgeError(message.error, "extension_error"));
  }

  private beat(): void {
    const conn = this.active;
    if (!conn) return;
    if (this.now() - conn.lastPong > HEARTBEAT_DEAD_MS) {
      conn.ws.terminate();
      return;
    }
    this.send(conn, { type: "ping" });
  }

  /* Identity ------------------------------------------------------------------ */

  private loadIdentity(): IdentityFile {
    try {
      const parsed = JSON.parse(readFileSync(this.identityPath, "utf8")) as Partial<IdentityFile>;
      if (typeof parsed.hostId === "string" && Array.isArray(parsed.paired)) {
        return {
          hostId: parsed.hostId,
          paired: parsed.paired.filter(
            (p): p is PairedBrowser =>
              typeof p?.browserId === "string" && typeof p.tokenHash === "string" && typeof p.pairedAt === "number",
          ),
        };
      }
    } catch {
      // first run or unreadable: mint a new identity below
    }
    const fresh: IdentityFile = { hostId: randomUUID(), paired: [] };
    this.identity = fresh;
    this.saveIdentity();
    return fresh;
  }

  private saveIdentity(): void {
    writeFileSync(this.identityPath, JSON.stringify(this.identity, null, 2));
    if (existsSync(this.identityPath)) {
      try {
        chmodSync(this.identityPath, 0o600);
      } catch {
        // Windows ignores POSIX modes
      }
    }
  }
}
