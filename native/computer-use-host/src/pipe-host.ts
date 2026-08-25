import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";
import { PIPE_NAME } from "./protocol.js";
import type { ComputerUseHostApi } from "./host-api.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const CONNECT_RETRY_ATTEMPTS = 30;
const CONNECT_RETRY_DELAY_MS = 200;
const PIPE_PATH = `\\\\.\\pipe\\${PIPE_NAME}`;

export interface PipeComputerUseHostOptions {
  hostExe: string;
  shotsDir: string;
  /** Optional log file for sidecar stderr (diagnostics when the pipe never opens). */
  logPath?: string;
  signal?: AbortSignal;
}

/** Persistent named-pipe client for the Windows native computer-use host. */
export class PipeComputerUseHost implements ComputerUseHostApi {
  private id = 0;
  private child: ChildProcess | null = null;
  private childExitCode: number | null = null;
  private launchError: Error | null = null;
  private socket: Socket | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private connecting: Promise<void> | null = null;

  private abortSignal?: AbortSignal;

  constructor(private readonly opts: PipeComputerUseHostOptions) {}

  setAbortSignal(signal?: AbortSignal): void {
    this.abortSignal = signal;
  }

  getHostExe(): string {
    return this.opts.hostExe;
  }

  private async ensureConnected(): Promise<void> {
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
    if (!existsSync(this.opts.hostExe)) {
      throw new Error(`Computer use host not found at ${this.opts.hostExe}`);
    }
    this.childExitCode = null;
    this.launchError = null;
    const logStream = this.opts.logPath ? createWriteStream(this.opts.logPath, { flags: "a" }) : null;
    if (logStream) {
      logStream.write(`\n--- spawn ${new Date().toISOString()} ${this.opts.hostExe} ---\n`);
    }
    this.child = spawn(this.opts.hostExe, [], {
      stdio: ["ignore", "ignore", logStream ? "pipe" : "ignore"],
      windowsHide: true,
      env: { ...process.env, DEYIN_COMPUTER_USE_SHOTS: this.opts.shotsDir },
    });
    if (logStream && this.child.stderr) {
      this.child.stderr.pipe(logStream);
    }
    this.child.on("error", (err) => {
      this.launchError = err;
      this.resetConnection();
    });
    this.child.on("exit", (code) => {
      this.childExitCode = code ?? null;
      this.resetConnection();
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(
            `Computer use host exited${code === null ? "" : ` (code ${code})`}. Install .NET 8 Desktop Runtime if missing.`,
          ),
        );
      }
      this.pending.clear();
    });

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < CONNECT_RETRY_ATTEMPTS; attempt++) {
      if (this.launchError) {
        throw new Error(
          `Computer use host failed to start: ${String(this.launchError)}. Path: ${this.opts.hostExe}. Check antivirus or reinstall Deyin.`,
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
        ? ` Sidecar pipe not found — the host may be blocked by antivirus or missing from the install. Expected: ${this.opts.hostExe}`
        : "";
    throw new Error((lastError?.message ?? "Could not connect to computer use host.") + hint);
  }

  private connectPipe(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = connect(PIPE_PATH);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.socket = socket;
        socket.on("data", (chunk) => this.onData(String(chunk)));
        socket.on("error", (err) => this.failAll(err));
        socket.on("close", () => {
          this.socket = null;
        });
        resolve();
      });
      socket.once("error", reject);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const res = JSON.parse(line) as JsonRpcResponse;
        const id = typeof res.id === "number" ? res.id : null;
        if (id === null) continue;
        const pending = this.pending.get(id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (res.error) pending.reject(new Error(res.error.message));
        else pending.resolve(res.result);
      } catch {
        // ignore malformed line
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private rpcOnce<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.abortSignal?.aborted || this.opts.signal?.aborted) throw new Error("Computer use cancelled.");
    const id = ++this.id;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Computer use RPC timed out: ${method}`));
      }, DEFAULT_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      const socket = this.socket;
      if (!socket || socket.destroyed) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Computer use host disconnected."));
        return;
      }
      const payload = `${JSON.stringify(req)}\n`;
      const writeOk = socket.write(payload, (writeErr) => {
        if (writeErr) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Computer use host disconnected: ${writeErr.message}`));
        }
      });
      if (!writeOk) {
        socket.once("drain", () => {
          // payload already queued; response handler above covers errors
        });
      }
    });
  }

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ensureConnected();
    try {
      return await this.rpcOnce<T>(method, params);
    } catch (err) {
      if (!isRetryableDisconnect(err)) throw err;
      this.resetConnection();
      this.child?.kill();
      this.child = null;
      await this.ensureConnected();
      return this.rpcOnce<T>(method, params);
    }
  }

  listApps() {
    return this.rpc("list_apps");
  }
  listWindows() {
    return this.rpc("list_windows");
  }
  getWindowState(windowId: string, opts?: { screenshot?: boolean; tree?: boolean }) {
    return this.rpc("get_window_state", { windowId, screenshot: opts?.screenshot, tree: opts?.tree });
  }
  launchApp(appId: string) {
    return this.rpc("launch_app", { appId });
  }
  click(windowId: string, ref: string) {
    return this.rpc("click", { windowId, ref });
  }
  typeText(windowId: string, text: string, ref?: string) {
    return this.rpc("type_text", { windowId, text, ref });
  }
  pressKey(windowId: string, key: string) {
    return this.rpc("press_key", { windowId, key });
  }
  scroll(windowId: string, deltaY: number) {
    return this.rpc("scroll", { windowId, deltaY });
  }
  drag(windowId: string, fromRef: string, toRef: string) {
    return this.rpc("drag", { windowId, fromRef, toRef });
  }
  setValue(windowId: string, ref: string, value: string) {
    return this.rpc("set_value", { windowId, ref, value });
  }
  async cancel(): Promise<void> {
    try {
      await this.rpc("cancel");
    } catch {
      // host may already be gone
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
    void this.cancel();
    this.resetConnection();
    this.child?.kill();
    this.child = null;
  }
}

export function resolveHostExe(resourcesPath?: string): string {
  const candidates = [
    resourcesPath ? join(resourcesPath, "computer-use-host", "deyin-computer-use-host.exe") : "",
    join(process.cwd(), "native/computer-use-host/native/bin/Release/net8.0-windows/win-x64/publish/deyin-computer-use-host.exe"),
    join(process.cwd(), "native/computer-use-host/native/bin/Release/net8.0-windows/win-x64/deyin-computer-use-host.exe"),
  ].filter(Boolean);
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
