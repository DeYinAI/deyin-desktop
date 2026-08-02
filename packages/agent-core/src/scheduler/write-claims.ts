import { realpathSync, lstatSync } from "node:fs";
import { platform } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_MAX_SUBAGENT_CONCURRENCY = 6;
export const DEFAULT_MAX_PARALLEL_WRITERS = 3;
export const MAX_SUBAGENT_CONCURRENCY_LIMIT = 32;

/** Normalized claim over workspace paths a subagent may write. */
export interface WritePathSet {
  paths: string[];
  wholeWorkspace: boolean;
  workspaceRoot: string;
}

export function writePathSetEmpty(set: WritePathSet): boolean {
  return !set.wholeWorkspace && set.paths.length === 0;
}

export function normalizeConcurrencyLimits(
  total: number,
  writers: number,
): { maxTotal: number; maxWriters: number } {
  let maxTotal = total > 0 ? total : DEFAULT_MAX_SUBAGENT_CONCURRENCY;
  let maxWriters = writers > 0 ? writers : DEFAULT_MAX_PARALLEL_WRITERS;
  if (maxTotal > MAX_SUBAGENT_CONCURRENCY_LIMIT) maxTotal = MAX_SUBAGENT_CONCURRENCY_LIMIT;
  if (maxWriters > MAX_SUBAGENT_CONCURRENCY_LIMIT) maxWriters = MAX_SUBAGENT_CONCURRENCY_LIMIT;
  if (maxWriters > maxTotal) maxWriters = maxTotal;
  return { maxTotal, maxWriters };
}

function foldPaths(): boolean {
  const p = platform();
  return p === "win32" || p === "darwin";
}

function foldPathKey(path: string): string {
  return foldPaths() ? path.toLowerCase() : path;
}

function pathWithinFold(root: string, target: string): boolean {
  if (!root || !target) return false;
  const r = foldPaths() ? root.toLowerCase() : root;
  const t = foldPaths() ? target.toLowerCase() : target;
  const rel = relative(r, t);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function normalizeExistingRoot(root: string): string {
  const trimmed = root.trim();
  if (!trimmed) throw new Error("workspace root is required for write_paths");
  const abs = resolve(trimmed);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function realPathForClaim(path: string): string {
  const abs = resolve(path);
  let cur = abs;
  let tail = "";
  for (;;) {
    try {
      return tail ? join(realpathSync(cur), tail) : realpathSync(cur);
    } catch {
      const parent = resolve(cur, "..");
      if (parent === cur) return abs;
      try {
        const stat = lstatSync(cur);
        if (stat.isSymbolicLink()) {
          throw new Error(`cannot resolve symlink path "${path}"`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("symlink")) throw err;
      }
      tail = tail ? join(cur.split(sep).pop() ?? "", tail) : (cur.split(sep).pop() ?? "");
      cur = parent;
    }
  }
}

function resolveWriteClaimPath(workspaceRoot: string, raw: string): string {
  const path = isAbsolute(raw) ? raw : join(workspaceRoot, raw);
  return realPathForClaim(path);
}

/** Validate and normalize declared write_paths against a workspace root. */
export function normalizeWritePaths(workspaceRoot: string, raw: string[]): WritePathSet {
  const root = normalizeExistingRoot(workspaceRoot);
  if (raw.length === 0) {
    return { paths: [], wholeWorkspace: false, workspaceRoot: root };
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]?.trim() ?? "";
    if (!entry) throw new Error(`write_paths[${i}]: path is required`);
    if (/[*?[\]]/.test(entry)) throw new Error(`write_paths[${i}]: globs are not allowed (${entry})`);
    const abs = resolveWriteClaimPath(root, entry);
    if (!pathWithinFold(root, abs)) {
      throw new Error(`write_paths[${i}]: path "${entry}" is outside the workspace`);
    }
    const key = foldPathKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(abs);
  }
  return { paths, wholeWorkspace: false, workspaceRoot: root };
}

/** Whole-workspace claim for writers that omitted write_paths. */
export function wholeWorkspaceWriteClaim(workspaceRoot: string): WritePathSet {
  const root = normalizeExistingRoot(workspaceRoot);
  return { paths: [], wholeWorkspace: true, workspaceRoot: root };
}

export function writePathSetsOverlap(a: WritePathSet, b: WritePathSet): boolean {
  if (writePathSetEmpty(a) || writePathSetEmpty(b)) return false;
  if (a.wholeWorkspace || b.wholeWorkspace) {
    if (!a.workspaceRoot || !b.workspaceRoot) return true;
    return pathWithinFold(a.workspaceRoot, b.workspaceRoot) || pathWithinFold(b.workspaceRoot, a.workspaceRoot);
  }
  for (const p of a.paths) {
    for (const q of b.paths) {
      if (pathWithinFold(p, q) || pathWithinFold(q, p)) return true;
    }
  }
  return false;
}

/** Fail if any pair of non-empty claims overlaps (fleet preflight). */
export function validateNonOverlappingWriteClaims(claims: WritePathSet[]): void {
  for (let i = 0; i < claims.length; i++) {
    if (writePathSetEmpty(claims[i]!)) continue;
    for (let j = i + 1; j < claims.length; j++) {
      if (writePathSetEmpty(claims[j]!)) continue;
      if (writePathSetsOverlap(claims[i]!, claims[j]!)) {
        throw new Error(`write path conflict between task ${i + 1} and task ${j + 1}`);
      }
    }
  }
}

function claimEqual(a: WritePathSet, b: WritePathSet): boolean {
  if (a.wholeWorkspace !== b.wholeWorkspace || a.workspaceRoot !== b.workspaceRoot) return false;
  if (a.paths.length !== b.paths.length) return false;
  return a.paths.every((p, i) => p === b.paths[i]);
}

export function removeWriteClaim(claims: WritePathSet[], target: WritePathSet): WritePathSet[] {
  const idx = claims.findIndex((c) => claimEqual(c, target));
  if (idx < 0) return claims;
  return [...claims.slice(0, idx), ...claims.slice(idx + 1)];
}
