import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, ComputerUseMethod } from "./protocol.js";
import { METHOD_TIMEOUT_MS, PIPE_NAME, RPC_CODES } from "./protocol.js";
import type {
  ActionResult,
  AppInfo,
  ClickOptions,
  ComputerUseHostApi,
  DisplayInfo,
  HostEvent,
  HostInfo,
  LaunchResult,
  ScrollOptions,
  StateOptions,
  Target,
  WindowInfo,
  WindowState,
  ActionMethod,
} from "./host-api.js";

const CONNECT_RETRY_ATTEMPTS = 30;
const CONNECT_RETRY_DELAY_MS = 200;

/** These never change anything, so repeating one after a dropped connection is safe. Actions are never repeated. */
const READ_ONLY_METHODS: ReadonlySet<ComputerUseMethod> = new Set([
  "ping",
  "list_apps",
  "list_windows",
  "get_window",
  "list_displays",
  "get_window_state",
]);

/** The run was stopped (by the user, the Stop key, or a taking-over mouse). Not a failure to report as one. */
export class HostCancelledError extends Error {
  constructor(message = "Computer use was stopped.") {
    super(message);
    this.name = "HostCancelledError";
  }
}

export class HostRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "HostRpcError";
  }
}

export interface PipeComputerUseHostOptions {
  hostExe: string;
  shotsDir: string;
  /** Optional log file for sidecar stderr (diagnostics when the pipe never opens). */
  logPath?: string;
  signal?: AbortSignal;
  /** Connect to a host that is already listening here instead of starting one (used by tests). */
  pipePath?: string;
}

interface Pending {
  method: ComputerUseMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  detach: () => void;
}

/** Persistent named-pipe client for the Windows native computer-use host. */
export class PipeComputerUseHost implements ComputerUseHostApi {
  private id = 0;
  private child: ChildProcess | null = null;
  private childExitCode: number | null = null;
  private launchError: Error | null = null;
  private socket: Socket | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private buffer = "";
  private connecting: Promise<void> | null = null;
  private abortSignal?: AbortSignal;
  private disposed = false;
  /** Unique per Deyin process, so a host left over from a crashed run is never adopted by mistake. */
  private readonly pipePath: string;

  constructor(private readonly opts: PipeComputerUseHostOptions) {
    this.pipePath = opts.pipePath ?? `\\\\.\\pipe\\${PIPE_NAME}-${process.pid}`;
  }

  setAbortSignal(signal?: AbortSignal): void {
    this.abortSignal = signal;
  }

  getHostExe(): string {
    return this.opts.hostExe;
  }

  onEvent(handler: (event: HostEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /* Connection ------------------------------------------------------------------ */

  private async ensureConnected(): Promise<void> {
    if (this.disposed) throw new HostCancelledError("Computer use host was shut down.");
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private resetConnection(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private async open(): Promise<void> {
    const external = Boolean(this.opts.pipePath);
    const hostExe = resolve(this.opts.hostExe);
    if (!external) {
      if (!existsSync(hostExe)) throw new Error(`Computer use host not found at ${hostExe}`);
      this.startHost(hostExe);
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < CONNECT_RETRY_ATTEMPTS; attempt++) {
      if (this.launchError) {
        throw new Error(
          `Computer use host failed to start: ${String(this.launchError)}. Path: ${hostExe}. Check antivirus or reinstall Deyin.`,
        );
      }
      if (this.childExitCode !== null) {
        throw new Error(
          `Computer use host exited (code ${this.childExitCode}). Install .NET 8 Desktop Runtime if missing, or check ${this.opts.logPath ?? "sidecar logs"}.`,
        );
      }
      try {
        await this.connectPipe();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.resetConnection();
        await sleep(CONNECT_RETRY_DELAY_MS);
      }
    }
    const hint =
      lastError?.message.includes("ENOENT") || lastError?.message.includes("connect")
        ? ` Sidecar pipe not found — the host may be blocked by antivirus or missing from the install. Expected: ${hostExe}`
        : "";
    throw new Error((lastError?.message ?? "Could not connect to computer use host.") + hint);
  }

  private startHost(hostExe: string): void {
    const hostDir = dirname(hostExe);
    this.childExitCode = null;
    this.launchError = null;
    const logStream = this.opts.logPath ? createWriteStream(this.opts.logPath, { flags: "a" }) : null;
    logStream?.write(`\n--- spawn ${new Date().toISOString()} ${hostExe} cwd=${hostDir} pipe=${this.pipePath} ---\n`);
    const pipeName = this.pipePath.split("\\").pop() ?? PIPE_NAME;
    // cwd must be the sidecar folder so self-contained .NET can load native DLLs
    // sitting next to deyin-computer-use-host.exe (Electron's process.cwd() is wrong).
    const child = spawn(hostExe, ["--pipe", pipeName, "--shots", this.opts.shotsDir, "--parent", String(process.pid)], {
      cwd: hostDir,
      stdio: ["ignore", "ignore", logStream ? "pipe" : "ignore"],
      windowsHide: true,
      env: { ...process.env, DEYIN_COMPUTER_USE_SHOTS: this.opts.shotsDir },
    });
    this.child = child;
    if (logStream && child.stderr) child.stderr.pipe(logStream);
    child.on("error", (err) => {
      this.launchError = err;
      this.resetConnection();
    });
    child.on("exit", (code) => {
      if (this.child !== child) return; // a replaced host; its exit is not news
      this.childExitCode = code ?? null;
      this.resetConnection();
      this.failAll(
        new Error(
          `Computer use host exited${code === null ? "" : ` (code ${code})`}. Install .NET 8 Desktop Runtime if missing.`,
        ),
      );
    });
  }

  private connectPipe(): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const socket = connect(this.pipePath);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.socket = socket;
        this.buffer = "";
        socket.on("data", (chunk) => this.onData(String(chunk)));
        socket.on("error", (err) => this.failAll(err));
        socket.on("close", () => {
          if (this.socket === socket) this.socket = null;
          this.failAll(new Error("Computer use host disconnected."));
        });
        resolvePromise();
      });
      socket.once("error", reject);
    });
  }

  /* Messages -------------------------------------------------------------------- */

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message: JsonRpcResponse | JsonRpcNotification;
      try {
        message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
      } catch {
        continue; // ignore a malformed line
      }
      if ("method" in message && message.method === "event") {
        this.emit({ type: String(message.params?.type ?? ""), data: message.params?.data });
        continue;
      }
      const response = message as JsonRpcResponse;
      const id = typeof response.id === "number" ? response.id : null;
      if (id === null) continue;
      const pending = this.pending.get(id);
      if (!pending) continue; // already timed out or cancelled
      this.settle(id, pending);
      if (response.error) {
        pending.reject(
          response.error.code === RPC_CODES.cancelled
            ? new HostCancelledError()
            : new HostRpcError(response.error.message, response.error.code),
        );
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private emit(event: HostEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a faulty listener must not break the connection
      }
    }
  }

  private settle(id: number, pending: Pending): void {
    clearTimeout(pending.timer);
    pending.detach();
    this.pending.delete(id);
  }

  private failAll(err: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.settle(id, pending);
      pending.reject(err);
    }
  }

  /** `ignoreSignal` is for `cancel` itself, which must go through after the abort that triggered it. */
  private rpcOnce<T>(method: ComputerUseMethod, params: Record<string, unknown>, ignoreSignal = false): Promise<T> {
    const signal = ignoreSignal ? undefined : (this.abortSignal ?? this.opts.signal);
    if (signal?.aborted) return Promise.reject(new HostCancelledError());
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("Computer use host disconnected."));

    const id = ++this.id;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolvePromise, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.settle(id, entry);
        reject(new HostCancelledError());
        // Tell the host to stop what it is doing; it also releases any held keys and the mouse.
        this.sendCancel();
      };
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.settle(id, entry);
        reject(new Error(`Computer use ${method} timed out.`));
        this.sendCancel();
      }, METHOD_TIMEOUT_MS[method]);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => resolvePromise(value as T),
        reject,
        timer,
        detach: () => signal?.removeEventListener("abort", onAbort),
      });
      socket.write(`${JSON.stringify(request)}\n`, (writeErr) => {
        if (!writeErr) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.settle(id, entry);
        reject(new Error(`Computer use host disconnected: ${writeErr.message}`));
      });
    });
  }

  private sendCancel(): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: ++this.id, method: "cancel", params: {} };
    socket.write(`${JSON.stringify(request)}\n`, () => undefined);
  }

  private async rpc<T>(method: ComputerUseMethod, params: Record<string, unknown> = {}): Promise<T> {
    await this.ensureConnected();
    try {
      return await this.rpcOnce<T>(method, params);
    } catch (err) {
      if (!READ_ONLY_METHODS.has(method) || !isRetryableDisconnect(err) || this.disposed) throw err;
      this.resetConnection();
      this.child?.kill();
      this.child = null;
      await this.ensureConnected();
      return this.rpcOnce<T>(method, params);
    }
  }

  /* API ------------------------------------------------------------------------- */

  info() {
    return this.rpc<HostInfo>("ping");
  }
  listApps() {
    return this.rpc<AppInfo[]>("list_apps");
  }
  listWindows() {
    return this.rpc<WindowInfo[]>("list_windows");
  }
  getWindow(windowId: string) {
    return this.rpc<WindowInfo>("get_window", { windowId });
  }
  listDisplays() {
    return this.rpc<DisplayInfo[]>("list_displays");
  }
  /** Tests only: the host refuses unless it was started with DEYIN_CU_TEST_HOOKS=1. */
  simulateTakeover() {
    return this.rpc<{ tripped: number }>("simulate_takeover");
  }
  getWindowState(windowId: string, opts?: StateOptions) {
    return this.rpc<WindowState>("get_window_state", { windowId, ...opts });
  }
  launchApp(appId: string) {
    return this.rpc<LaunchResult>("launch_app", { appId });
  }
  click(windowId: string, opts: ClickOptions) {
    return this.rpc<ActionResult>("click", { windowId, ...opts });
  }
  hover(windowId: string, target: Target) {
    return this.rpc<ActionResult>("hover", { windowId, ...target });
  }
  typeText(windowId: string, text: string, opts?: { ref?: string; method?: ActionMethod }) {
    return this.rpc<ActionResult>("type_text", { windowId, text, ...opts });
  }
  pressKey(windowId: string, key: string) {
    return this.rpc<ActionResult>("press_key", { windowId, key });
  }
  scroll(windowId: string, opts: ScrollOptions) {
    return this.rpc<ActionResult>("scroll", { windowId, ...opts });
  }
  drag(windowId: string, from: Target, to: Target) {
    return this.rpc<ActionResult>("drag", {
      windowId,
      fromRef: from.ref,
      fromX: from.x,
      fromY: from.y,
      toRef: to.ref,
      toX: to.x,
      toY: to.y,
    });
  }
  setValue(windowId: string, ref: string, value: string) {
    return this.rpc<ActionResult>("set_value", { windowId, ref, value });
  }

  async cancel(): Promise<void> {
    // Nothing to stop when there is no connection; never start a host just to cancel.
    if (!this.socket || this.socket.destroyed) return;
    try {
      await this.rpcOnce("cancel", {}, true);
    } catch {
      // the host may already be gone
    }
  }

  async ping() {
    try {
      await this.rpc("ping");
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.sendCancel();
    this.disposed = true;
    this.failAll(new HostCancelledError("Computer use host was shut down."));
    this.resetConnection();
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}

export function resolveHostExe(resourcesPath?: string): string {
  const candidates = [
    resourcesPath ? join(resourcesPath, "computer-use-host", "deyin-computer-use-host.exe") : "",
    join(process.cwd(), "native/computer-use-host/native/bin/Release/net8.0-windows/win-x64/publish/deyin-computer-use-host.exe"),
    join(process.cwd(), "native/computer-use-host/native/bin/Release/net8.0-windows/win-x64/deyin-computer-use-host.exe"),
  ]
    .filter(Boolean)
    .map((p) => resolve(p));
  return candidates.find((p) => existsSync(p)) ?? candidates[0] ?? "";
}

export function hostLogPath(dataDir: string): string {
  return join(dataDir, "host.log");
}

function isRetryableDisconnect(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("disconnected") || msg.includes("eof") || msg.includes("econnreset") || msg.includes("broken pipe");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
