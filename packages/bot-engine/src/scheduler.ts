import type { EngineRoutine } from "@deyin/host-core";
import { checkSchedule, cronJobFactory, type JobFactory, type ScheduleJob } from "./cron.js";
import type { EngineStore } from "./store.js";

export type RoutineTrigger = "schedule" | "manual";

export interface SchedulerDeps {
  store: EngineStore;
  /** Run one routine. Called when its schedule fires; must not throw. */
  fire: (botId: string, routine: EngineRoutine, trigger: RoutineTrigger) => void;
  jobFactory?: JobFactory;
  now?: () => number;
}

const keyOf = (botId: string, routineId: string): string => `${botId}/${routineId}`;

/**
 * Keeps one schedule per enabled routine and fires it. The routines on disk are the truth: `syncBot` makes the
 * running schedules match them. A routine whose schedule no longer passes the checks (the clock rules changed, or the
 * file was edited by hand) is left unscheduled and reported, never run on a schedule the desktop would refuse.
 */
export class RoutineScheduler {
  private readonly jobs = new Map<string, ScheduleJob>();
  private readonly factory: JobFactory;

  constructor(private readonly deps: SchedulerDeps) {
    this.factory = deps.jobFactory ?? cronJobFactory;
  }

  /** Make the schedules of one Bot match its routines. Returns the routines that could not be scheduled, with why. */
  syncBot(botId: string): Array<{ routineId: string; error: string }> {
    const wanted = new Map(this.deps.store.routines(botId).map((r) => [r.id, r]));
    for (const key of [...this.jobs.keys()]) {
      if (key.startsWith(`${botId}/`) && !wanted.has(key.slice(botId.length + 1))) this.stopKey(key);
    }
    const problems: Array<{ routineId: string; error: string }> = [];
    for (const routine of wanted.values()) {
      const key = keyOf(botId, routine.id);
      // Restart every time: the routine may have a new schedule, and restarting costs nothing.
      this.stopKey(key);
      if (!routine.enabled) continue;
      const check = checkSchedule(routine.cron, (this.deps.now ?? Date.now)());
      if (!check.ok) {
        problems.push({ routineId: routine.id, error: check.error });
        continue;
      }
      this.jobs.set(
        key,
        this.factory(routine.cron, () => {
          // The latest copy, not the one the job was made with: a pause or an edit applies at once.
          const current = this.deps.store.routines(botId).find((r) => r.id === routine.id);
          if (current?.enabled) this.deps.fire(botId, current, "schedule");
        }),
      );
    }
    return problems;
  }

  syncAll(): void {
    for (const botId of this.deps.store.botIds()) this.syncBot(botId);
  }

  /** Stop and forget every schedule of a Bot. */
  dropBot(botId: string): void {
    for (const key of [...this.jobs.keys()]) if (key.startsWith(`${botId}/`)) this.stopKey(key);
  }

  nextRunAt(botId: string, routineId: string): number | undefined {
    return this.jobs.get(keyOf(botId, routineId))?.nextRunAt();
  }

  scheduledCount(botId?: string): number {
    if (botId === undefined) return this.jobs.size;
    return [...this.jobs.keys()].filter((key) => key.startsWith(`${botId}/`)).length;
  }

  stop(): void {
    for (const key of [...this.jobs.keys()]) this.stopKey(key);
  }

  private stopKey(key: string): void {
    this.jobs.get(key)?.stop();
    this.jobs.delete(key);
  }
}
