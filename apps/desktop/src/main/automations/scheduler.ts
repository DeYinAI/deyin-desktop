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

/** Cron scheduler for enabled automations. */
export class AutomationScheduler {
  private jobs = new Map<string, Cron>();

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
        void this.maybeCatchUp(automation);
      }
    } catch (err) {
      console.error(
        `[automations] skipping invalid cron for ${automation.id} (${automation.name}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async maybeCatchUp(automation: Automation): Promise<void> {
    if (automation.trigger.kind !== "cron") return;
    const job = this.jobs.get(automation.id);
    if (!job) return;
    const prev = job.previousRun();
    if (!prev) return;
    const scheduledAt = prev.getTime();
    if (automation.lastScheduledAt && automation.lastScheduledAt >= scheduledAt) return;
    this.callbacks.onTrigger(automation.id, scheduledAt);
  }

  notifyAutomationChanged(): void {
    this.refresh();
  }

  dispose(): void {
    this.disposeJobs();
  }

  private disposeJobs(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }
}
