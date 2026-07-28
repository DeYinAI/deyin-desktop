import { resolve } from "node:path";
import { TerminalManager, detectEnv, readTextFile, readTree } from "@deyin/host-core";
import type { EnvInfo, FileNode, TerminalCreateOptions } from "../shared/protocol.js";

/**
 * A per-session sandbox root confines all file + terminal activity. On real deployments
 * each session runs in its own container; the root here is that container's workspace.
 *
 * File walking, environment detection and PTY management come from @deyin/host-core
 * (shared with the desktop app and the CLI); this class adds the per-session scoping.
 */
export class SessionHost {
  private readonly terminals: TerminalManager;

  constructor(
    private readonly root: string,
    emit: (msg: { type: "term.data"; termId: string; data: string } | { type: "term.exit"; termId: string; exitCode: number }) => void,
  ) {
    this.terminals = new TerminalManager(
      {
        onData: (termId, data) => emit({ type: "term.data", termId, data }),
        onExit: (termId, exitCode) => emit({ type: "term.exit", termId, exitCode }),
      },
      { defaultCwd: () => this.root },
    );
  }

  /** Reject any path that escapes the session root (path traversal guard). */
  private safeResolve(path: string): string {
    const abs = resolve(this.root, path);
    if (abs !== this.root && !abs.startsWith(this.root + "/")) {
      throw new Error("Path escapes session root");
    }
    return abs;
  }

  async tree(dir?: string): Promise<FileNode[]> {
    const start = dir ? this.safeResolve(dir) : this.root;
    return readTree(start, 2);
  }

  async read(path: string): Promise<string> {
    return readTextFile(this.safeResolve(path));
  }

  env(): Promise<EnvInfo> {
    return detectEnv();
  }

  async createTerminal(opts: TerminalCreateOptions): Promise<string> {
    // Terminals are always rooted in the sandbox, regardless of the requested cwd.
    return this.terminals.create({ ...opts, cwd: this.root });
  }

  writeTerminal(id: string, data: string): void {
    this.terminals.write(id, data);
  }
  resizeTerminal(id: string, cols: number, rows: number): void {
    this.terminals.resize(id, cols, rows);
  }
  killTerminal(id: string): void {
    this.terminals.kill(id);
  }
  dispose(): void {
    this.terminals.disposeAll();
  }
}
