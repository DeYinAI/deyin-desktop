import { Cron } from "croner";
import type { Automation, AutomationsStore } from "@deyin/host-core";

export interface SchedulerCallbacks {
  onTrigger: (automationId: string, scheduledAt: number) => void;
  isCatchUpEnabled: () => boolean;
}

/** Returns null when the expression is valid; otherwise an error message. */
export function validateCronExpression(expression: string): string | null {
  const trimmed = expression.trim();
  if (!trimmed) return "Cron expression is empty.";
  try {
    // Construct without a callback — throws on invalid patterns.
    const job = new Cron(trimmed, { paused: true });
    job.stop();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid cron expression.";
  }
}

/**
 * How far back a catch-up run will reach. A machine that was off for a month
 * should not replay a month of history; it should run once, now. Matches the
 * behaviour users already expect from other desktop agent schedulers.
 */
const CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;


/**
 * Last scheduled occurrence strictly after `notBefore` and at or before `now`,
 * or null when the expression had no slot in that span.
 *
 * croner's own `previousRun()` reports the last time *this job object* actually
 * fired, which is always null for a job constructed at startup — so it cannot
 * answer "did we miss a slot while the app was closed". Walking `nextRun()`
 * forward from the lower bound does. The bound is the catch-up window, so the
 * walk is short (a 5-minute cron over 7 days is the worst realistic case, and
 * MAX_STEPS caps even that).
 */
export function previousOccurrence(expression: string, notBefore: number, now: number): number | null {
  const MAX_STEPS = 5_000;
  let job: Cron;
  try {
    job = new Cron(expression, { paused: true });
  } catch {
    return null;
  }
  try {
    let cursor = new Date(notBefore);
    let last: number | null = null;
    for (let i = 0; i < MAX_STEPS; i++) {
      const next = job.nextRun(cursor);
      if (!next) break;
      const at = next.getTime();
      if (at > now) break;
      last = at;
      cursor = next;
    }
    return last;
  } finally {
    job.stop();
  }
}

/** Cron scheduler for enabled automations. */
export class AutomationScheduler {
  private jobs = new Map<string, Cron>();
  private disposed = false;

  constructor(
    private readonly store: AutomationsStore,
    private readonly callbacks: SchedulerCallbacks,
  ) {}

  refresh(): void {
    this.disposeJobs();
    for (const automation of this.store.list()) {
      if (!automation.enabled || automation.trigger.kind !== "cron") continue;
      this.schedule(automation);
    }
  }

  private schedule(automation: Automation): void {
    if (automation.trigger.kind !== "cron") return;
    const expression = automation.trigger.expression;
    try {
      const job = new Cron(expression, { protect: true }, () => {
        const scheduledAt = Date.now();
        this.callbacks.onTrigger(automation.id, scheduledAt);
      });
      this.jobs.set(automation.id, job);

      if (this.callbacks.isCatchUpEnabled()) {
        this.maybeCatchUp(automation);
      }
    } catch (err) {
      console.error(
        `[automations] skipping invalid cron for ${automation.id} (${automation.name}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Fire at most one run for the most recently missed slot. Older misses are
   * discarded: a daily automation that missed six days runs once, not six times.
   */
  private maybeCatchUp(automation: Automation): void {
    if (automation.trigger.kind !== "cron") return;
    const now = Date.now();
    // Only look back as far as the window, and never re-run a claimed slot.
    const notBefore = Math.max(automation.lastScheduledAt ?? 0, now - CATCH_UP_WINDOW_MS);
    const scheduledAt = previousOccurrence(automation.trigger.expression, notBefore, now);
    if (scheduledAt === null) return;
    this.callbacks.onTrigger(automation.id, scheduledAt);
  }

  /**
   * Re-evaluate catch-up after the machine wakes. croner timers do not fire for
   * slots that elapsed while the host was suspended, so without this a laptop
   * closed overnight silently skips every overnight run.
   */
  handleResume(): void {
    if (this.disposed || !this.callbacks.isCatchUpEnabled()) return;
    for (const automation of this.store.list()) {
      if (!automation.enabled || automation.trigger.kind !== "cron") continue;
      this.maybeCatchUp(automation);
    }
  }

  notifyAutomationChanged(): void {
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.disposeJobs();
  }

  private disposeJobs(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }
}
