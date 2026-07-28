import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileNode } from "../types.js";

const IGNORED = new Set([".git", "node_modules", ".DS_Store", "dist", "out", ".cache"]);

/**
 * Shallow-to-bounded file tree for a workspace root. Depth-limited to keep the payload
 * small; the renderer lazy-loads deeper directories on expand.
 */
export async function readTree(root: string, maxDepth = 2): Promise<FileNode[]> {
  return walk(root, 0, maxDepth);
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

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

const MAX_READ_BYTES = 1_000_000;

/** Read a text file, capped so the consumer never receives an unbounded blob. */
export async function readTextFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.subarray(0, MAX_READ_BYTES).toString("utf8");
}
