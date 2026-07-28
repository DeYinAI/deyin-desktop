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

/** Manages PTY-backed terminals and streams their output to the host's sink. */
export class TerminalManager {
  private terminals = new Map<string, IPty>();

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

  write(id: string, data: string): void {
    this.terminals.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.resize(cols, rows);
  }

  kill(id: string): void {
    this.terminals.get(id)?.kill();
    this.terminals.delete(id);
  }

  disposeAll(): void {
    for (const term of this.terminals.values()) term.kill();
    this.terminals.clear();
  }
}
