import type { Clock } from "../../src/main/automations/watchdog.js";

/** Let queued promise callbacks run (they chain a few deep, and timers fire between them). */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A clock that only moves when told to, firing due timers in order as it passes them.
 *
 * Two seams in the app take timers, with different spellings and different timing
 * expectations, so this serves both explicitly:
 *
 *  - `Clock` (automations watchdog): `now` / `setTimeout` / `clearTimeout`, driven by
 *    `await advance(...)`. Yielding between fires matters here — the watchdog arms its
 *    grace timer from a `.then()`, and abandoning a run settles over several turns.
 *  - `InstallTimers` (update installer): `set` / `clear` / `pendingCount`, driven by
 *    `advanceNow(...)`. That code schedules its next timer synchronously inside the
 *    previous one, so the installer tests step the clock with no yielding at all.
 *
 * `advance` (async) is the default; installer tests that used to call `advance`
 * synchronously should call `advanceNow`.
 */
export class FakeClock implements Clock {
  t = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** `InstallTimers` spelling of {@link setTimeout}. */
  readonly set = (fn: () => void, ms: number): number => this.setTimeout(fn, ms) as number;

  /** `InstallTimers` spelling of {@link clearTimeout}. */
  readonly clear = (handle: unknown): void => this.clearTimeout(handle);

  /** Timers still waiting; zero once a supervised run has cleaned up. */
  pending(): number {
    return this.timers.size;
  }

  /** `InstallTimers` tests read the count as a property, not a call. */
  get pendingCount(): number {
    return this.pending();
  }

  /** The next timer due at or before `end`, without firing it. */
  private dueBy(end: number): number | undefined {
    let dueId: number | undefined;
    let dueAt = Infinity;
    for (const [id, timer] of this.timers) {
      if (timer.at <= end && timer.at < dueAt) {
        dueId = id;
        dueAt = timer.at;
      }
    }
    return dueId;
  }

  /** Fire one timer and advance the clock to its instant. */
  private fire(id: number): void {
    const timer = this.timers.get(id);
    if (!timer) return;
    this.timers.delete(id);
    this.t = Math.max(this.t, timer.at);
    timer.fn();
  }

  /**
   * Move time forward without yielding: every timer due in the window fires, including
   * ones the callbacks schedule synchronously. For code that chains timers directly.
   */
  advanceNow(ms: number): void {
    const end = this.t + ms;
    for (let id = this.dueBy(end); id !== undefined; id = this.dueBy(end)) this.fire(id);
    this.t = end;
  }

  /**
   * Move time forward, yielding between fires.
   *
   * Timers fire as the clock walks forward, so a callback that awaits before arming its
   * next timer is still caught inside the window. Await this.
   */
  async advance(ms: number): Promise<void> {
    const start = this.t;
    const end = start + ms;
    // Already-due timers fire first, and time lands on `end` so consecutive unawaited
    // calls compose from where this one stopped.
    for (let id = this.dueBy(start); id !== undefined; id = this.dueBy(start)) this.fire(id);
    this.t = end;
    // Replay the window, yielding after each fire so promise-chained work can arm its
    // next timer before the next pass.
    this.t = start;
    for (;;) {
      const id = this.dueBy(end);
      if (id === undefined) break;
      this.fire(id);
      await flush(1);
    }
    this.t = end;
    await flush();
  }
}
