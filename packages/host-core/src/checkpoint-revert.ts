import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { FileCheckpointEntry, CheckpointStore } from "./checkpoints.js";
import type { Storage } from "./storage.js";
import type { RevertResult } from "./types.js";

export type { RevertResult };

/** Host-provided file operations for checkpoint revert (local or remote backend). */
export interface CheckpointFileOps {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  resolveInsideRoot(path: string): Promise<string>;
}

export interface RevertGuard {
  /** True when an agent run is active on this thread — revert must be blocked. */
  isAgentRunning?(threadId: string): boolean;
  /** True when pending review items exist — revert must be blocked. */
  hasPendingReview?(threadId: string): boolean;
}

interface RollbackJournal {
  paths: Record<string, string | null>;
}

function guardRevert(threadId: string, guards: RevertGuard | undefined): RevertResult | null {
  if (guards?.isAgentRunning?.(threadId)) {
    return { ok: false, revertedPaths: [], error: "Cannot revert while an agent run is in progress." };
  }
  if (guards?.hasPendingReview?.(threadId)) {
    return {
      ok: false,
      revertedPaths: [],
      error: "Resolve pending file reviews before reverting.",
    };
  }
  return null;
}

/** Pick the pre-change content: earliest applied entry in the revert set per path. */
function targetBeforeByPath(entries: FileCheckpointEntry[]): Map<string, string> {
  const byPath = new Map<string, FileCheckpointEntry>();
  for (const entry of entries) {
    const prev = byPath.get(entry.path);
    if (!prev || entry.appliedAt < prev.appliedAt) {
      byPath.set(entry.path, entry);
    }
  }
  const targets = new Map<string, string>();
  for (const [path, entry] of byPath) {
    targets.set(path, entry.before);
  }
  return targets;
}

async function snapshotPaths(
  ops: CheckpointFileOps,
  paths: string[],
): Promise<RollbackJournal> {
  const journal: RollbackJournal = { paths: {} };
  for (const path of paths) {
    const safe = await ops.resolveInsideRoot(path);
    const exists = await ops.exists(safe);
    if (!exists) {
      journal.paths[safe] = null;
    } else {
      journal.paths[safe] = await ops.readText(safe);
    }
  }
  return journal;
}

async function restoreJournal(ops: CheckpointFileOps, journal: RollbackJournal): Promise<void> {
  for (const [path, content] of Object.entries(journal.paths)) {
    if (content === null) {
      if (await ops.exists(path)) await ops.delete(path);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await ops.writeText(path, content);
    }
  }
}

async function applyTarget(
  ops: CheckpointFileOps,
  path: string,
  targetBefore: string,
): Promise<void> {
  const safe = await ops.resolveInsideRoot(path);
  if (targetBefore === "") {
    if (await ops.exists(safe)) await ops.delete(safe);
    return;
  }
  await mkdir(dirname(safe), { recursive: true });
  await ops.writeText(safe, targetBefore);
}

async function persistRollbackJournal(storage: Storage, journal: RollbackJournal): Promise<string> {
  const id = randomUUID();
  storage.writeJson(`checkpoint-rollback-${id}.json`, journal);
  return id;
}

async function deleteRollbackJournal(storage: Storage, id: string): Promise<void> {
  try {
    const { unlink: unlinkFs } = await import("node:fs/promises");
    const { join: joinPath } = await import("node:path");
    await unlinkFs(joinPath(storage.dir, `checkpoint-rollback-${id}.json`));
  } catch {
    // best-effort cleanup
  }
}

/** Revert all file changes recorded under one checkpoint (agent run). */
export async function revertCheckpoint(
  store: CheckpointStore,
  storage: Storage,
  ops: CheckpointFileOps,
  threadId: string,
  checkpointId: string,
  guards?: RevertGuard,
  opts?: { paths?: string[] },
): Promise<RevertResult> {
  const blocked = guardRevert(threadId, guards);
  if (blocked) return blocked;

  const all = store.list(threadId);
  let entries = all.filter((e) => e.checkpointId === checkpointId && e.revertedAt === undefined);
  if (opts?.paths?.length) {
    const allowed = new Set(opts.paths);
    entries = entries.filter((e) => allowed.has(e.path));
  }
  if (entries.length === 0) {
    return { ok: true, revertedPaths: [] };
  }

  return applyRevert(store, storage, ops, threadId, entries);
}

/** Revert file changes from multiple checkpoints (edit-and-resend tail). */
export async function revertCheckpoints(
  store: CheckpointStore,
  storage: Storage,
  ops: CheckpointFileOps,
  threadId: string,
  checkpointIds: string[],
  guards?: RevertGuard,
): Promise<RevertResult> {
  const blocked = guardRevert(threadId, guards);
  if (blocked) return blocked;

  const idSet = new Set(checkpointIds);
  const entries = store
    .list(threadId)
    .filter((e) => e.revertedAt === undefined && idSet.has(e.checkpointId));
  if (entries.length === 0) {
    return { ok: true, revertedPaths: [] };
  }

  return applyRevert(store, storage, ops, threadId, entries);
}

async function applyRevert(
  store: CheckpointStore,
  storage: Storage,
  ops: CheckpointFileOps,
  threadId: string,
  entries: FileCheckpointEntry[],
): Promise<RevertResult> {
  const targets = targetBeforeByPath(entries);
  const paths = [...targets.keys()];
  const journal = await snapshotPaths(ops, paths);
  const rollbackId = await persistRollbackJournal(storage, journal);

  const revertedPaths: string[] = [];
  try {
    for (const [path, targetBefore] of targets) {
      await applyTarget(ops, path, targetBefore);
      revertedPaths.push(path);
    }
  } catch (err) {
    const failed = revertedPaths.at(-1) ?? paths[0];
    try {
      await restoreJournal(ops, journal);
    } catch (rollbackErr) {
      console.warn(
        `[deyin] checkpoint revert rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
      );
    }
    await deleteRollbackJournal(storage, rollbackId);
    return {
      ok: false,
      revertedPaths: [],
      failed,
      rolledBack: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const entryKeys = entries.map((e) => ({
    checkpointId: e.checkpointId,
    path: e.path,
    appliedAt: e.appliedAt,
  }));
  await store.markReverted(threadId, entryKeys);
  await deleteRollbackJournal(storage, rollbackId);
  return { ok: true, revertedPaths };
}

/** Build file ops from a workspace root (used in tests and simple hosts). */
export function checkpointFileOpsFromRoot(
  _root: string,
  resolveInsideRoot: (path: string) => Promise<string>,
): CheckpointFileOps {
  return {
    readText: async (path) => readFile(await resolveInsideRoot(path), "utf8"),
    writeText: async (path, content) => {
      const safe = await resolveInsideRoot(path);
      await mkdir(dirname(safe), { recursive: true });
      await writeFile(safe, content, "utf8");
    },
    delete: async (path) => {
      const safe = await resolveInsideRoot(path);
      await unlink(safe).catch(() => undefined);
    },
    exists: async (path) => {
      try {
        const { access } = await import("node:fs/promises");
        await access(await resolveInsideRoot(path));
        return true;
      } catch {
        return false;
      }
    },
    resolveInsideRoot,
  };
}
