import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { CH } from "../../shared/ipc.js";
import type { TerminalCreateOptions } from "../../shared/types.js";
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

/** Manages PTY-backed terminals and streams their output to the renderer. */
export class TerminalManager {
  private terminals = new Map<string, IPty>();

  constructor(private readonly getSender: () => WebContents | null) {}

  async create(opts: TerminalCreateOptions): Promise<string> {
    const pty = await loadPty();
    if (!pty) throw new Error("Terminal support is unavailable (node-pty not built).");

    const id = randomUUID();
    const shell = await resolveShell(opts.shell);
    const term = pty.spawn(shell.path, shell.args, {
      name: "xterm-color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd ?? process.env.HOME ?? process.cwd(),
      env: process.env,
    });

    term.onData((data) => this.getSender()?.send(CH.termData, { id, data }));
    term.onExit(({ exitCode }) => {
      this.getSender()?.send(CH.termExit, { id, exitCode });
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
