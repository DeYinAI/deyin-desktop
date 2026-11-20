import { Cron } from "croner";
import { ROUTINE_LIMITS, routineSpacingError } from "@deyin/host-core";

/** How many upcoming runs are compared; enough to see any pattern within a day, and to bound the walk. */
const SPACING_SAMPLES = 200;

export type ScheduleCheck = { ok: true; nextRunAt: number } | { ok: false; error: string };

/** The shortest gap between two consecutive runs, or null when there are fewer than two. */
export function minGapMs(expression: string, from: number): number | null {
  const job = new Cron(expression, { paused: true });
  try {
    const runs = job.nextRuns(SPACING_SAMPLES, new Date(from));
    if (runs.length < 2) return null;
    let min = Number.POSITIVE_INFINITY;
    for (let i = 1; i < runs.length; i += 1) min = Math.min(min, runs[i]!.getTime() - runs[i - 1]!.getTime());
    return min;
  } finally {
    job.stop();
  }
}

/** Whether a schedule parses, runs again, and is no closer together than a routine may be. */
export function checkSchedule(expression: string, from: number = Date.now()): ScheduleCheck {
  let next: Date | null;
  try {
    const job = new Cron(expression, { paused: true });
    try {
      next = job.nextRun(new Date(from));
    } finally {
      job.stop();
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `That schedule does not parse: ${error.message}` : "That schedule does not parse." };
  }
  if (!next) return { ok: false, error: "That schedule never runs." };
  const gap = routineSpacingError(minGapMs(expression, from), ROUTINE_LIMITS);
  return gap ? { ok: false, error: gap } : { ok: true, nextRunAt: next.getTime() };
}

/** One running schedule. A seam so tests can fire a job by hand instead of waiting for a clock. */
export interface ScheduleJob {
  nextRunAt(): number | undefined;
  stop(): void;
}

export type JobFactory = (expression: string, onTick: () => void) => ScheduleJob;

/** The real thing: croner, in the server's time zone, never overlapping itself. */
export const cronJobFactory: JobFactory = (expression, onTick) => {
  const job = new Cron(expression, { protect: true }, onTick);
  return {
    nextRunAt: () => job.nextRun()?.getTime(),
    stop: () => job.stop(),
  };
};
