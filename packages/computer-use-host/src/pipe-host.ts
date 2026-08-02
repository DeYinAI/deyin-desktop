import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";
import { PIPE_NAME } from "./protocol.js";
import type { ComputerUseHostApi } from "./host-api.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const PIPE_PATH = `\\\\.\\pipe\\${PIPE_NAME}`;

export interface PipeComputerUseHostOptions {
  hostExe: string;
  shotsDir: string;
  signal?: AbortSignal;
}

/** Persistent named-pipe client for the Windows native computer-use host. */
export class PipeComputerUseHost implements ComputerUseHostApi {
  private id = 0;
  private child: ChildProcess | null = null;
  private socket: Socket | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private connecting: Promise<void> | null = null;

  private abortSignal?: AbortSignal;

  constructor(private readonly opts: PipeComputerUseHostOptions) {}

  setAbortSignal(signal?: AbortSignal): void {
    this.abortSignal = signal;
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

  private async open(): Promise<void> {
    if (!existsSync(this.opts.hostExe)) {
      throw new Error(`Computer use host not found at ${this.opts.hostExe}`);
    }
    this.child = spawn(this.opts.hostExe, [], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, DEYIN_COMPUTER_USE_SHOTS: this.opts.shotsDir },
    });
    this.child.on("exit", () => {
      this.socket?.destroy();
      this.socket = null;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Computer use host exited."));
      }
      this.pending.clear();
    });
    await sleep(300);
    await new Promise<void>((resolve, reject) => {
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

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.abortSignal?.aborted || this.opts.signal?.aborted) throw new Error("Computer use cancelled.");
    await this.ensureConnected();
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
      this.socket?.write(`${JSON.stringify(req)}\n`);
    });
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
    this.socket?.destroy();
    this.child?.kill();
    this.child = null;
  }
}

export function resolveHostExe(resourcesPath?: string): string {
  const candidates = [
    resourcesPath ? join(resourcesPath, "computer-use-host", "deyin-computer-use-host.exe") : "",
    join(process.cwd(), "packages/computer-use-host/native/bin/Release/net8.0-windows/win-x64/publish/deyin-computer-use-host.exe"),
    join(process.cwd(), "packages/computer-use-host/native/bin/Release/net8.0-windows/win-x64/deyin-computer-use-host.exe"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? candidates[0] ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
