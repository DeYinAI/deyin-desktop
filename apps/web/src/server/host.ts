import { TerminalManager, assertInsideRoot, detectEnv, readTextFile, readTree, writeTextFile } from "@deyin/host-core";
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

  async tree(dir?: string): Promise<FileNode[]> {
    const start = dir ? assertInsideRoot(this.root, dir) : this.root;
    return readTree(start, 2);
  }

  async read(path: string): Promise<string> {
    return readTextFile(assertInsideRoot(this.root, path));
  }

  async write(path: string, content: string): Promise<void> {
    return writeTextFile(assertInsideRoot(this.root, path), content);
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
