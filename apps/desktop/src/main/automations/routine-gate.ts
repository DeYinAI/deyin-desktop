import { Cron } from "croner";
import {
  RoutineRateLimiter,
  describeRateRefusal,
  routineSpacingError,
  type Automation,
  type AutomationTrigger,
  type BotResult,
} from "@deyin/host-core";

/** How many upcoming runs are compared; enough to see any pattern within a day, and to bound the walk. */
const SPACING_SAMPLES = 200;

/**
 * The shortest gap between two consecutive runs of a cron schedule, looking at the next runs from `from`,
 * or null when it has fewer than two. Throws on an expression croner cannot parse.
 */
export function cronMinGapMs(expression: string, from: number, samples: number = SPACING_SAMPLES): number | null {
  const job = new Cron(expression, { paused: true });
  try {
    const runs = job.nextRuns(samples, new Date(from));
    if (runs.length < 2) return null;
    let min = Number.POSITIVE_INFINITY;
    for (let i = 1; i < runs.length; i += 1) min = Math.min(min, runs[i]!.getTime() - runs[i - 1]!.getTime());
    return min;
  } finally {
    job.stop();
  }
}

/**
 * Why a routine's schedule is not allowed, or null when it is. Only a repeating cron has a gap to check; an
 * expression that does not parse is the cron validator's to report, not this one's.
 */
export function routineScheduleError(trigger: AutomationTrigger, from: number = Date.now()): string | null {
  if (trigger.kind !== "cron") return null;
  let gap: number | null;
  try {
    gap = cronMinGapMs(trigger.expression, from);
  } catch {
    return null;
  }
  return routineSpacingError(gap);
}

export interface RoutineGateDeps {
  /** Whether the Bot a routine belongs to can run now; the error says why not. */
  resolveBot: (botId: string) => BotResult<unknown>;
  limiter?: RoutineRateLimiter;
}

/**
 * Decides, at the moment a run would start, whether a routine may run. A Bot that can no longer run
 * (deleted, archived) is checked first, so a run that was never going to happen does not use up the hour's allowance.
 */
export class RoutineGate {
  private readonly limiter: RoutineRateLimiter;

  constructor(private readonly deps: RoutineGateDeps) {
    this.limiter = deps.limiter ?? new RoutineRateLimiter();
  }

  /** The reason the run must not start (written to its history row), or null to let it go ahead. Plain automations always pass. */
  admit(automation: Pick<Automation, "id" | "botId">, now: number): string | null {
    if (automation.botId === undefined) return null;
    const bot = this.deps.resolveBot(automation.botId);
    if (!bot.ok) return `skipped: ${bot.error}`;
    const decision = this.limiter.admit(automation.id, now);
    return decision.ok ? null : `rate-limited: ${describeRateRefusal(decision)}`;
  }

  forget(automationId: string): void {
    this.limiter.forget(automationId);
  }
}
