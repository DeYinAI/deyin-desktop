import { randomUUID } from "node:crypto";
import type { TerminalCreateOptions } from "../types.js";
import { resolveShell } from "./env.js";

interface IPty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface PtyModule {
  spawn(file: string, args: string[], opts: Record<string, unknown>): IPty;
}

/** Minimal handle for an externally-owned PTY (e.g. AgentShell) registered for attach. */
export interface RegisteredTerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Kill the underlying process. Owner still owns lifecycle; this is best-effort. */
  kill(): void;
  /** Raw scrollback to replay when a tab attaches. */
  getScrollback(): string;
}

let ptyModule: PtyModule | null | undefined;

async function loadPty(): Promise<PtyModule | null> {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = (await import("node-pty")) as unknown as PtyModule;
  } catch {
    console.warn("[deyin] node-pty unavailable; terminal disabled in this build.");
    ptyModule = null;
  }
  return ptyModule;
}

/** Where terminal output goes: the desktop sends IPC events, the web pushes WS frames. */
export interface TerminalEvents {
  onData(id: string, data: string): void;
  onExit(id: string, exitCode: number): void;
}

export interface TerminalManagerOptions {
  /** Fallback cwd when TerminalCreateOptions.cwd is absent (defaults to $HOME, then cwd). */
  defaultCwd?: () => string | undefined;
}

export interface TerminalAttachResult {
  scrollback: string;
}

/** Manages PTY-backed terminals and streams their output to the host's sink. */
export class TerminalManager {
  private terminals = new Map<string, IPty>();
  private registered = new Map<string, RegisteredTerminal>();

  constructor(
    private readonly events: TerminalEvents,
    private readonly options: TerminalManagerOptions = {},
  ) {}

  async create(opts: TerminalCreateOptions): Promise<string> {
    const pty = await loadPty();
    if (!pty) throw new Error("Terminal support is unavailable (node-pty not built).");

    const id = randomUUID();
    const shell = await resolveShell(opts.shell);
    const term = pty.spawn(shell.path, shell.args, {
      name: "xterm-color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd ?? this.options.defaultCwd?.() ?? process.env.HOME ?? process.cwd(),
      env: process.env,
    });

    term.onData((data) => this.events.onData(id, data));
    term.onExit(({ exitCode }) => {
      this.events.onExit(id, exitCode);
      this.terminals.delete(id);
    });

    this.terminals.set(id, term);
    return id;
  }

  /**
   * Register an externally-owned PTY (e.g. AgentShell) so the renderer can
   * attach, write, and resize it via the normal terminal IPC path. Data must
   * already be pushed through `events.onData`/`onExit` by the owner.
   */
  register(id: string, handle: RegisteredTerminal): void {
    this.registered.set(id, handle);
  }

  /** True when an externally-owned terminal handle is currently registered. */
  isRegistered(id: string): boolean {
    return this.registered.has(id);
  }

  unregister(id: string): void {
    this.registered.delete(id);
  }

  /** Return scrollback for a registered (or unknown-empty) terminal id. */
  attach(id: string): TerminalAttachResult {
    const handle = this.registered.get(id);
    if (handle) return { scrollback: handle.getScrollback() };
    // Owned PTYs have no ring buffer; attach still succeeds so the tab can listen.
    if (this.terminals.has(id)) return { scrollback: "" };
    throw new Error(`Unknown terminal: ${id}`);
  }

  write(id: string, data: string): void {
    const owned = this.terminals.get(id);
    if (owned) {
      owned.write(data);
      return;
    }
    this.registered.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const owned = this.terminals.get(id);
    if (owned) {
      owned.resize(cols, rows);
      return;
    }
    this.registered.get(id)?.resize(cols, rows);
  }

  kill(id: string): void {
    const owned = this.terminals.get(id);
    if (owned) {
      owned.kill();
      this.terminals.delete(id);
      return;
    }
    // Externally owned: do not kill the agent shell from a tab close — just detach.
    // The Agent tab close should leave the shell running for subsequent tool calls.
  }

  disposeAll(): void {
    for (const term of this.terminals.values()) term.kill();
    this.terminals.clear();
    this.registered.clear();
  }
}
