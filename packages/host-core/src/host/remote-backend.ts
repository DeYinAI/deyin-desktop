import type { DirectoryEntry, FileNode, WorkspaceLocation } from "../types.js";
import { assertInsideRemoteRoot, normalizeRemotePath, shellQuote } from "./remote-paths.js";
import type { HostBackend } from "./backend.js";
import type { RemoteExec } from "./remote-git.js";

export interface SftpLike {
  readdir(
    path: string,
    cb: (
      err: Error | null | undefined,
      list?: Array<{ filename: string; attrs: { isDirectory(): boolean; isFile(): boolean } }>,
    ) => void,
  ): void;
  createReadStream(path: string): NodeJS.ReadableStream;
  createWriteStream(path: string): NodeJS.WritableStream;
}

function sftpReaddir(
  sftp: SftpLike,
  dir: string,
): Promise<Array<{ filename: string; attrs: { isDirectory(): boolean; isFile(): boolean } }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => {
      if (err) reject(err);
      else resolve(list ?? []);
    });
  });
}

function sftpReadFile(sftp: SftpLike, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(path);
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("close", () => resolve(Buffer.concat(chunks)));
  });
}

function sftpWriteFile(sftp: SftpLike, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(path);
    stream.on("error", reject);
    stream.on("close", () => resolve());
    stream.end(content, "utf8");
  });
}

/** Remote SSH workspace backed by SFTP + exec. */
export class RemoteHostBackend implements HostBackend {
  readonly location: WorkspaceLocation;
  readonly displayRoot: string;
  readonly isRemote = true;

  constructor(
    hostId: string,
    root: string,
    private readonly sftp: SftpLike,
    private readonly exec: RemoteExec,
    readonly readOnly = false,
    displayLabel?: string,
  ) {
    const normalized = normalizeRemotePath(root);
    this.location = { kind: "remote", hostId, root: normalized };
    this.displayRoot = displayLabel ?? normalized;
  }

  execRoot(): string {
    return this.location.root;
  }

  async connect(): Promise<void> {
    const r = await this.exec(`test -d ${shellQuote(this.location.root)}`);
    if (r.code !== 0) throw new Error(`Remote path not found: ${this.location.root}`);
  }

  async disconnect(): Promise<void> {
    /* pool owns lifecycle */
  }

  async listDirectory(dir: string): Promise<DirectoryEntry[]> {
    const target = assertInsideRemoteRoot(this.location.root, dir);
    let entries;
    try {
      entries = await sftpReaddir(this.sftp, target);
    } catch {
      return [];
    }
    const rows: DirectoryEntry[] = entries.map((e) => ({
      name: e.filename,
      path: normalizeRemotePath(`${target}/${e.filename}`),
      kind: e.attrs.isDirectory() ? "directory" : "file",
    }));
    rows.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return rows;
  }

  async readTree(dir?: string, maxDepth = 2): Promise<FileNode[]> {
    const base = dir ? assertInsideRemoteRoot(this.location.root, dir) : this.location.root;
    return this.walkRemote(base, 0, maxDepth);
  }

  private async walkRemote(dir: string, depth: number, maxDepth: number): Promise<FileNode[]> {
    const entries = await this.listDirectory(dir);
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.kind === "directory") {
        nodes.push({
          name: entry.name,
          path: entry.path,
          type: "directory",
          children: depth < maxDepth ? await this.walkRemote(entry.path, depth + 1, maxDepth) : undefined,
        });
      } else {
        nodes.push({ name: entry.name, path: entry.path, type: "file" });
      }
    }
    return nodes;
  }

  async readText(absPath: string): Promise<string> {
    const path = assertInsideRemoteRoot(this.location.root, absPath);
    const buf = await sftpReadFile(this.sftp, path);
    return buf.subarray(0, 1_000_000).toString("utf8");
  }

  async writeText(absPath: string, content: string): Promise<void> {
    if (this.readOnly) throw new Error("Remote workspace is read-only");
    const path = assertInsideRemoteRoot(this.location.root, absPath);
    await sftpWriteFile(this.sftp, path, content);
  }

  async resolveInsideRoot(path: string): Promise<string> {
    return assertInsideRemoteRoot(this.location.root, path);
  }
}

/** List a remote directory for the SSH folder picker (outside workspace root). */
export async function listRemoteDirectory(sftp: SftpLike, dir: string): Promise<DirectoryEntry[]> {
  const target = normalizeRemotePath(dir || "/");
  let entries;
  try {
    entries = await sftpReaddir(sftp, target);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.attrs.isDirectory())
    .map((e) => ({
      name: e.filename,
      path: normalizeRemotePath(`${target}/${e.filename}`),
      kind: "directory" as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
