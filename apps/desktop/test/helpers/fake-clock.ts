/** Manually driven timers, shaped like the `InstallTimers` seam in update-install.ts. */
export class FakeClock {
  private now = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();

  readonly set = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  };

  readonly clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** Timers still waiting to fire. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Move time forward, firing due timers in order (including ones they schedule). */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.pending) {
        if (timer.at <= target && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === null) break;
      const timer = this.pending.get(nextId);
      this.pending.delete(nextId);
      this.now = nextAt;
      timer?.fn();
    }
    this.now = target;
  }
}
