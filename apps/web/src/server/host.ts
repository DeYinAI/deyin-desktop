import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { arch, hostname, platform, release } from "node:os";
import type { EnvInfo, FileNode, ShellInfo, TerminalCreateOptions } from "../shared/protocol.js";

const IGNORED = new Set([".git", "node_modules", ".DS_Store", "dist", "out", ".cache"]);

/**
 * A per-session sandbox root confines all file + terminal activity. On real deployments
 * each session runs in its own container; the root here is that container's workspace.
 */
export class SessionHost {
  private terminals = new Map<string, IPty>();

  constructor(
    private readonly root: string,
    private readonly emit: (msg: { type: "term.data"; termId: string; data: string } | { type: "term.exit"; termId: string; exitCode: number }) => void,
  ) {}

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
    return walk(start, 0, 2);
  }

  async read(path: string): Promise<string> {
    const abs = this.safeResolve(path);
    const buf = await readFile(abs);
    return buf.subarray(0, 1_000_000).toString("utf8");
  }

  env(): EnvInfo {
    return detectHostEnv();
  }

  async createTerminal(opts: TerminalCreateOptions): Promise<string> {
    const pty = await loadPty();
    if (!pty) throw new Error("Terminal unavailable (node-pty not built).");
    const id = randomUUID();
    const env = detectHostEnv();
    const pick =
      env.shells.find((s) => s.id === opts.shell) ??
      env.shells.find((s) => s.id === env.defaultShell);
    const shell = pick?.path ?? (platform() === "win32" ? "powershell.exe" : process.env.SHELL ?? "/bin/bash");
    const term = pty.spawn(shell, pick?.args ?? [], {
      name: "xterm-color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: this.root,
      env: process.env,
    });
    term.onData((data) => this.emit({ type: "term.data", termId: id, data }));
    term.onExit(({ exitCode }) => {
      this.emit({ type: "term.exit", termId: id, exitCode });
      this.terminals.delete(id);
    });
    this.terminals.set(id, term);
    return id;
  }

  writeTerminal(id: string, data: string): void {
    this.terminals.get(id)?.write(data);
  }
  resizeTerminal(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.resize(cols, rows);
  }
  killTerminal(id: string): void {
    this.terminals.get(id)?.kill();
    this.terminals.delete(id);
  }
  dispose(): void {
    for (const t of this.terminals.values()) t.kill();
    this.terminals.clear();
  }
}

async function walk(dir: string, depth: number, maxDepth: number): Promise<FileNode[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: full,
        type: "directory",
        children: depth < maxDepth ? await walk(full, depth + 1, maxDepth) : undefined,
      });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path: full, type: "file" });
    }
  }
  nodes.sort((a, b) => (a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name)));
  return nodes;
}

const POSIX_CANDIDATES = ["/bin/bash", "/usr/bin/zsh", "/bin/zsh", "/usr/bin/fish"];

let envCache: EnvInfo | undefined;

/** Detect the host environment for web sessions (posix shells; WSL2 flagged when present). */
function detectHostEnv(): EnvInfo {
  if (envCache) return envCache;

  const os = platform();
  const shells: ShellInfo[] = [];
  if (os !== "win32") {
    const userShell = process.env.SHELL ?? "/bin/bash";
    const seen = new Set<string>();
    for (const path of [userShell, ...POSIX_CANDIDATES]) {
      if (seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      const name = path.split("/").pop() ?? path;
      shells.push({ id: name, label: name, path, kind: "posix" });
    }
  } else {
    shells.push({ id: "powershell", label: "PowerShell", path: "powershell.exe", kind: "windows" });
  }

  let wsl2 = false;
  if (os === "linux") {
    wsl2 = /microsoft/i.test(release());
    if (!wsl2) {
      try {
        wsl2 = /microsoft/i.test(readFileSync("/proc/version", "utf8"));
      } catch {
        wsl2 = false;
      }
    }
  }

  envCache = {
    platform: os,
    arch: arch(),
    wsl2,
    wslDistros: [],
    shells,
    defaultShell: shells[0]?.id ?? "bash",
    hostname: hostname(),
  };
  return envCache;
}

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
    ptyModule = null;
  }
  return ptyModule;
}
