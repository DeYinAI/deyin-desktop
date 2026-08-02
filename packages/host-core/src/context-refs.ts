import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { assertInsideRoot } from "./host/paths.js";
import type { ContextRef, ContextSearchHit, ResolvedContextFile } from "./types.js";

export type { ContextRef, ContextSearchHit, ResolvedContextFile };

const IGNORED = new Set([".git", "node_modules", ".DS_Store", "dist", "out", ".cache"]);
const MAX_FILE_CHARS = 20_000;
const MAX_FOLDER_FILES = 40;

/** Fuzzy-search workspace paths for the @ mention picker. */
export async function searchContextPaths(
  root: string | null,
  query: string,
  limit = 12,
): Promise<ContextSearchHit[]> {
  if (!root) return [];
  const q = query.toLowerCase().trim();
  const hits: ContextSearchHit[] = [];
  await walkSearch(root, root, q, hits, limit);
  return hits.slice(0, limit);
}

async function walkSearch(
  root: string,
  dir: string,
  query: string,
  hits: ContextSearchHit[],
  limit: number,
): Promise<void> {
  if (hits.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (hits.length >= limit) return;
    if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full).replace(/\\/g, "/");
    const label = rel || entry.name;
    const matches = !query || label.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query);
    if (entry.isDirectory()) {
      if (matches) hits.push({ path: full, kind: "folder", label });
      await walkSearch(root, full, query, hits, limit);
    } else if (entry.isFile() && matches) {
      hits.push({ path: full, kind: "file", label });
    }
  }
}

/** Read file/folder contents for @ attachments (token-budget aware). */
export async function resolveContextRefs(
  root: string | null,
  refs: ContextRef[],
): Promise<ResolvedContextFile[]> {
  if (!root || refs.length === 0) return [];
  const out: ResolvedContextFile[] = [];
  for (const ref of refs) {
    let abs: string;
    try {
      abs = assertInsideRoot(root, ref.path);
    } catch {
      continue;
    }
    if (ref.kind === "file") {
      const file = await readContextFile(abs);
      if (file) out.push(file);
    } else {
      const folder = await readContextFolder(root, abs);
      if (folder) out.push(folder);
    }
  }
  return out;
}

async function readContextFile(abs: string): Promise<ResolvedContextFile | null> {
  try {
    const st = await stat(abs);
    if (!st.isFile()) return null;
    let content = await readFile(abs, "utf8");
    let truncated = false;
    if (content.length > MAX_FILE_CHARS) {
      content = `${content.slice(0, MAX_FILE_CHARS)}\n... [truncated — attach a smaller file or use read tool for the full file]`;
      truncated = true;
    }
    return { path: abs, kind: "file", content, truncated };
  } catch {
    return null;
  }
}

async function readContextFolder(root: string, abs: string): Promise<ResolvedContextFile | null> {
  try {
    const st = await stat(abs);
    if (!st.isDirectory()) return null;
    const lines: string[] = [`Directory listing for ${relative(root, abs).replace(/\\/g, "/") || basename(abs)}:`];
    let count = 0;
    const queue = [abs];
    while (queue.length > 0 && count < MAX_FOLDER_FILES) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (count >= MAX_FOLDER_FILES) break;
        if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        try {
          assertInsideRoot(root, full);
        } catch {
          continue;
        }
        const rel = relative(root, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          lines.push(`${rel}/`);
          queue.push(full);
        } else if (entry.isFile()) {
          lines.push(rel);
        }
        count += 1;
      }
    }
    if (count >= MAX_FOLDER_FILES) lines.push(`... [listing capped at ${MAX_FOLDER_FILES} entries]`);
    return { path: abs, kind: "folder", content: lines.join("\n") };
  } catch {
    return null;
  }
}

export { formatUserMessageWithContext, dedupeContextRefs } from "./context-message.js";
