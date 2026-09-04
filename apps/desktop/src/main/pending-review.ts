import { randomUUID } from "node:crypto";
import { applyFileMutationDirect, type FileMutationRequest } from "@deyin/agent-core";
import type { PendingChange } from "@deyin/host-core/shared";

type Outcome = "applied" | "rejected";
type Resolver = (outcome: Outcome) => void;

interface PendingEntry {
  change: PendingChange;
  request: FileMutationRequest;
  resolve: Resolver;
  onApplied?: (change: FileChangeLike) => void;
}

interface FileChangeLike {
  path: string;
  before: string;
  after: string;
  operation?: "write" | "edit" | "delete";
}

/** Per-thread queue of file mutations awaiting user review. */
export class PendingReviewQueue {
  private readonly byThread = new Map<string, Map<string, PendingEntry>>();
  /** changeId → webContents.id that queued the change */
  private readonly changeOwners = new Map<string, number>();

  list(threadId: string): PendingChange[] {
    const map = this.byThread.get(threadId);
    if (!map) return [];
    return [...map.values()].map((e) => e.change);
  }

  listAll(): PendingChange[] {
    const all: PendingChange[] = [];
    for (const map of this.byThread.values()) {
      all.push(...[...map.values()].map((e) => e.change));
    }
    return all;
  }

  async request(
    threadId: string,
    request: FileMutationRequest,
    reviewEnabled: boolean,
    webContentsId: number,
    onPending: (change: PendingChange) => void,
    onApplied: (change: FileChangeLike) => void,
  ): Promise<Outcome> {
    if (!reviewEnabled) {
      await applyFileMutationDirect(request);
      onApplied({
        path: request.path,
        before: request.before,
        after: request.after,
        operation: request.operation,
      });
      return "applied";
    }

    return new Promise<Outcome>((resolve) => {
      const change: PendingChange = {
        id: randomUUID(),
        threadId,
        path: request.path,
        before: request.before,
        after: request.after,
        tool: request.operation,
        status: "pending",
        createdAt: Date.now(),
      };
      let map = this.byThread.get(threadId);
      if (!map) {
        map = new Map();
        this.byThread.set(threadId, map);
      }
      map.set(change.id, { change, request, resolve, onApplied });
      this.changeOwners.set(change.id, webContentsId);
      onPending(change);
    });
  }

  approve(threadId: string, changeId: string, webContentsId: number): boolean {
    const owner = this.changeOwners.get(changeId);
    if (owner !== undefined && owner !== webContentsId) return false;
    const entry = this.byThread.get(threadId)?.get(changeId);
    if (!entry || entry.change.status !== "pending") return false;
    void this.applyEntry(entry);
    return true;
  }

  reject(threadId: string, changeId: string, webContentsId: number): boolean {
    const owner = this.changeOwners.get(changeId);
    if (owner !== undefined && owner !== webContentsId) return false;
    const map = this.byThread.get(threadId);
    const entry = map?.get(changeId);
    if (!entry || entry.change.status !== "pending") return false;
    entry.change.status = "rejected";
    map!.delete(changeId);
    this.changeOwners.delete(changeId);
    entry.resolve("rejected");
    return true;
  }

  async approveAll(threadId: string, webContentsId: number): Promise<string[]> {
    const map = this.byThread.get(threadId);
    if (!map) return [];
    const entries = [...map.values()].filter((e) => e.change.status === "pending");
    for (const entry of entries) {
      const owner = this.changeOwners.get(entry.change.id);
      if (owner !== undefined && owner !== webContentsId) return [];
    }
    const ids: string[] = [];
    for (const entry of entries) {
      ids.push(entry.change.id);
      await this.applyEntry(entry);
    }
    return ids;
  }

  rejectAll(threadId: string, webContentsId: number): string[] {
    const map = this.byThread.get(threadId);
    if (!map) return [];
    const entries = [...map.values()].filter((e) => e.change.status === "pending");
    for (const entry of entries) {
      const owner = this.changeOwners.get(entry.change.id);
      if (owner !== undefined && owner !== webContentsId) return [];
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.change.status !== "pending") continue;
      entry.change.status = "rejected";
      entry.resolve("rejected");
      map.delete(entry.change.id);
      this.changeOwners.delete(entry.change.id);
      ids.push(entry.change.id);
    }
    return ids;
  }

  clearThread(threadId: string): void {
    const map = this.byThread.get(threadId);
    if (!map) return;
    for (const entry of map.values()) {
      if (entry.change.status === "pending") entry.resolve("rejected");
      this.changeOwners.delete(entry.change.id);
    }
    this.byThread.delete(threadId);
  }

  private async applyEntry(entry: PendingEntry): Promise<void> {
    const map = this.byThread.get(entry.change.threadId);
    if (!map?.has(entry.change.id)) return;
    try {
      await applyFileMutationDirect(entry.request);
      entry.change.status = "approved";
      map.delete(entry.change.id);
      this.changeOwners.delete(entry.change.id);
      entry.onApplied?.({
        path: entry.request.path,
        before: entry.request.before,
        after: entry.request.after,
        operation: entry.request.operation,
      });
      entry.resolve("applied");
    } catch {
      entry.change.status = "rejected";
      map.delete(entry.change.id);
      this.changeOwners.delete(entry.change.id);
      entry.resolve("rejected");
    }
  }
}
