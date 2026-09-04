import type { FileCheckpointEntry } from "./types.js";
import type { Storage } from "./storage.js";

export type { FileCheckpointEntry };

export interface ThreadCheckpoints {
  threadId: string;
  entries: FileCheckpointEntry[];
}

export interface FileCheckpointRecord {
  path: string;
  before: string;
  after: string;
  operation: "write" | "edit" | "delete";
}

/** Durable per-thread log of file mutations keyed by agent run (checkpointId). */
export class CheckpointStore {
  constructor(private readonly storage: Storage) {}

  getStorage(): Storage {
    return this.storage;
  }

  private fileName(threadId: string): string {
    return `checkpoints-${threadId}.json`;
  }

  private load(threadId: string): ThreadCheckpoints {
    return this.storage.readJson<ThreadCheckpoints>(this.fileName(threadId), {
      threadId,
      entries: [],
    });
  }

  private save(state: ThreadCheckpoints): void {
    this.storage.writeJson(this.fileName(state.threadId), state);
  }

  async record(
    threadId: string,
    checkpointId: string,
    change: FileCheckpointRecord,
  ): Promise<FileCheckpointEntry> {
    const state = this.load(threadId);
    const entry: FileCheckpointEntry = {
      path: change.path,
      operation: change.operation,
      before: change.before,
      after: change.after,
      checkpointId,
      appliedAt: Date.now(),
    };
    state.entries.push(entry);
    this.save(state);
    await this.storage.flush();
    return entry;
  }

  list(threadId: string): FileCheckpointEntry[] {
    return this.load(threadId).entries;
  }

  /** Active (not yet reverted) entries for a checkpoint, optionally filtered by path. */
  activeEntries(
    threadId: string,
    checkpointId: string,
    path?: string,
  ): FileCheckpointEntry[] {
    return this.load(threadId).entries.filter(
      (e) =>
        e.checkpointId === checkpointId &&
        e.revertedAt === undefined &&
        (path === undefined || e.path === path),
    );
  }

  /** Active entries whose checkpointId is in the given set. */
  activeEntriesForCheckpoints(threadId: string, checkpointIds: Set<string>): FileCheckpointEntry[] {
    return this.load(threadId).entries.filter(
      (e) => e.revertedAt === undefined && checkpointIds.has(e.checkpointId),
    );
  }

  async markReverted(
    threadId: string,
    keys: Array<{ checkpointId: string; path: string; appliedAt: number }>,
  ): Promise<void> {
    if (keys.length === 0) return;
    const state = this.load(threadId);
    const now = Date.now();
    const keySet = new Set(keys.map((k) => `${k.checkpointId}\0${k.path}\0${k.appliedAt}`));
    state.entries = state.entries.map((e) =>
      keySet.has(`${e.checkpointId}\0${e.path}\0${e.appliedAt}`) ? { ...e, revertedAt: now } : e,
    );
    this.save(state);
    await this.storage.flush();
  }

  /** Remove entries for checkpoints that no longer exist in the timeline (edit-and-resend). */
  async pruneCheckpoints(threadId: string, keepCheckpointIds: Set<string>): Promise<void> {
    const state = this.load(threadId);
    const next = state.entries.filter((e) => keepCheckpointIds.has(e.checkpointId));
    if (next.length === state.entries.length) return;
    this.save({ threadId, entries: next });
    await this.storage.flush();
  }

  hasActiveEntries(threadId: string, checkpointId: string): boolean {
    return this.activeEntries(threadId, checkpointId).length > 0;
  }
}
