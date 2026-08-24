import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DirectoryEntry, FileNode, WorkspaceLocation } from "../types.js";
import { readTextFile, readTree, writeTextFile } from "./files.js";
import { assertInsideRoot } from "./paths.js";
import type { HostBackend } from "./backend.js";

/** Local disk workspace backed by node:fs. */
export class LocalHostBackend implements HostBackend {
  readonly location: WorkspaceLocation;
  readonly displayRoot: string;
  readonly isRemote = false;
  readonly readOnly = false;

  constructor(root: string) {
    this.location = { kind: "local", root };
    this.displayRoot = root;
  }

  execRoot(): string {
    return this.location.root;
  }

  async connect(): Promise<void> {
    /* local is always connected */
  }

  async disconnect(): Promise<void> {
    /* no-op */
  }

  async listDirectory(dir: string): Promise<DirectoryEntry[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const rows: DirectoryEntry[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        rows.push({ name: entry.name, path: full, kind: "directory" });
      } else if (entry.isFile()) {
        rows.push({ name: entry.name, path: full, kind: "file" });
      }
    }
    rows.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return rows;
  }

  async readTree(dir?: string, maxDepth = 2): Promise<FileNode[]> {
    const target = dir ? assertInsideRoot(this.location.root, dir) : this.location.root;
    return readTree(target, maxDepth);
  }

  async readText(absPath: string): Promise<string> {
    return readTextFile(assertInsideRoot(this.location.root, absPath));
  }

  async writeText(absPath: string, content: string): Promise<void> {
    return writeTextFile(assertInsideRoot(this.location.root, absPath), content);
  }

  async resolveInsideRoot(path: string): Promise<string> {
    return assertInsideRoot(this.location.root, path);
  }
}
