import {
  DEFAULT_MAX_PARALLEL_WRITERS,
  DEFAULT_MAX_SUBAGENT_CONCURRENCY,
  normalizeConcurrencyLimits,
  removeWriteClaim,
  type WritePathSet,
  writePathSetEmpty,
  writePathSetsOverlap,
} from "./write-claims.js";

export type SubagentSlotStatus = "queued" | "running" | "done" | "failed";

export interface SchedulerConfig {
  maxSubagentConcurrency: number;
  maxParallelWriters: number;
}

export interface AcquireRequest {
  writer: boolean;
  writePaths: WritePathSet;
  nested: boolean;
  label?: string;
}

interface SchedulerWaiter {
  req: AcquireRequest;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
}

/**
 * Session-wide concurrency gate for subagent coordination.
 * Readers run concurrently; writers require exclusive path claims.
 */
export class SubagentScheduler {
  private maxTotal: number;
  private maxWriters: number;
  private activeTotal = 0;
  private activeWriters = 0;
  private activeClaims: WritePathSet[] = [];
  private parentClaims: WritePathSet[] = [];
  private waiters: SchedulerWaiter[] = [];

  constructor(config: SchedulerConfig) {
    const limits = normalizeConcurrencyLimits(config.maxSubagentConcurrency, config.maxParallelWriters);
    this.maxTotal = limits.maxTotal;
    this.maxWriters = limits.maxWriters;
  }

  limits(): { total: number; writers: number } {
    return { total: this.maxTotal, writers: this.maxWriters };
  }

  /**
   * Reserve a concurrency slot (and optional write claim).
   * Nested requests fail immediately when capacity is exhausted.
   */
  async acquire(req: AcquireRequest, signal?: AbortSignal): Promise<() => void> {
    const canStart = this.canStart(req);
    if (canStart.ok) {
      this.activate(req);
      return this.makeRelease(req);
    }
    if (req.nested) {
      throw new Error(
        `subagent concurrency limit reached (${canStart.reason}); nested subagents fail fast to avoid parent/child slot deadlock`,
      );
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: SchedulerWaiter = {
        req,
        resolve,
        reject,
      };
      this.waiters.push(waiter);

      const onAbort = (): void => {
        this.removeWaiter(waiter);
        reject(new Error("acquire aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pumpWaiters();
    });
  }

  /** Synchronous try-acquire for preflight (no queue). */
  tryAcquire(req: AcquireRequest): { acquired: boolean; reason?: string; release?: () => void } {
    const canStart = this.canStart(req);
    if (!canStart.ok) {
      return { acquired: false, reason: canStart.reason };
    }
    this.activate(req);
    return { acquired: true, release: this.makeRelease(req) };
  }

  tryClaimWritePaths(paths: WritePathSet): void {
    if (writePathSetEmpty(paths)) return;
    const err = this.conflict(paths);
    if (err) throw err;
  }

  /** Hold paths during parent write-tool execution without consuming a subagent slot. */
  reserveParentWrite(paths: WritePathSet): () => void {
    const noop = (): void => undefined;
    if (writePathSetEmpty(paths)) return noop;
    const err = this.conflict(paths);
    if (err) throw err;
    this.parentClaims.push(paths);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.parentClaims = removeWriteClaim(this.parentClaims, paths);
      this.pumpWaiters();
    };
  }

  activeWriterClaims(): WritePathSet[] {
    return [...this.activeClaims, ...this.parentClaims];
  }

  private conflict(paths: WritePathSet): Error | null {
    for (const active of this.activeClaims) {
      if (writePathSetsOverlap(active, paths)) {
        return new Error(
          "write path is claimed by a running background subagent; wait for it to finish before writing the same path",
        );
      }
    }
    for (const active of this.parentClaims) {
      if (writePathSetsOverlap(active, paths)) {
        return new Error("write path is claimed by another parent write in progress");
      }
    }
    return null;
  }

  private canStart(req: AcquireRequest): { ok: boolean; reason?: string } {
    if (this.activeTotal >= this.maxTotal) {
      return { ok: false, reason: `total concurrency ${this.activeTotal}/${this.maxTotal}` };
    }
    if (!req.writer) return { ok: true };
    if (this.activeWriters >= this.maxWriters) {
      return { ok: false, reason: `writer concurrency ${this.activeWriters}/${this.maxWriters}` };
    }
    if (!writePathSetEmpty(req.writePaths)) {
      const err = this.conflict(req.writePaths);
      if (err) return { ok: false, reason: err.message };
    }
    return { ok: true };
  }

  private activate(req: AcquireRequest): void {
    this.activeTotal++;
    if (req.writer) {
      this.activeWriters++;
      if (!writePathSetEmpty(req.writePaths)) {
        this.activeClaims.push(req.writePaths);
      }
    }
  }

  private deactivate(req: AcquireRequest): void {
    if (this.activeTotal > 0) this.activeTotal--;
    if (req.writer) {
      if (this.activeWriters > 0) this.activeWriters--;
      if (!writePathSetEmpty(req.writePaths)) {
        this.activeClaims = removeWriteClaim(this.activeClaims, req.writePaths);
      }
    }
  }

  private makeRelease(req: AcquireRequest): () => void {
    let once = false;
    return () => {
      if (once) return;
      once = true;
      this.deactivate(req);
      this.pumpWaiters();
    };
  }

  private pumpWaiters(): void {
    if (this.waiters.length === 0) return;
    const remaining: SchedulerWaiter[] = [];
    for (const w of this.waiters) {
      const canStart = this.canStart(w.req);
      if (canStart.ok) {
        this.activate(w.req);
        w.resolve(this.makeRelease(w.req));
      } else {
        remaining.push(w);
      }
    }
    this.waiters = remaining;
  }

  private removeWaiter(target: SchedulerWaiter): void {
    this.waiters = this.waiters.filter((w) => w !== target);
  }
}

/** Per-session scheduler registry. */
const sessionSchedulers = new Map<string, SubagentScheduler>();

export function getSessionScheduler(sessionId: string, config?: Partial<SchedulerConfig>): SubagentScheduler {
  let sched = sessionSchedulers.get(sessionId);
  if (!sched) {
    sched = new SubagentScheduler({
      maxSubagentConcurrency: config?.maxSubagentConcurrency ?? DEFAULT_MAX_SUBAGENT_CONCURRENCY,
      maxParallelWriters: config?.maxParallelWriters ?? DEFAULT_MAX_PARALLEL_WRITERS,
    });
    sessionSchedulers.set(sessionId, sched);
  }
  return sched;
}

export function clearSessionScheduler(sessionId: string): void {
  sessionSchedulers.delete(sessionId);
}
