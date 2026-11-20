import type { Automation } from "../types.js";

/**
 * A routine is an automation a Bot owns: it runs as that Bot (its persona and memory, in its own
 * files folder) on a schedule or by hand. Everything else about it — cron, run history, pausing,
 * healing — is the automation machinery, so there is no second scheduler.
 *
 * The numbers are the documented Grok Bot limits.
 */
export interface RoutineLimits {
  /** Routines one Bot may own. */
  perBot: number;
  /** The shortest gap a schedule may have between two runs. */
  minSpacingMinutes: number;
  /** Run records kept per routine (enforced by the run store's own cap). */
  runRecords: number;
  /** Runs per rolling hour across every routine. */
  perHourAccount: number;
  /** Runs per rolling hour for one routine. */
  perHourPerRoutine: number;
}

export const ROUTINE_LIMITS: Readonly<RoutineLimits> = Object.freeze({
  perBot: 50,
  minSpacingMinutes: 5,
  runRecords: 20,
  perHourAccount: 300,
  perHourPerRoutine: 200,
});

const HOUR_MS = 60 * 60 * 1000;

export function isRoutine(automation: Pick<Automation, "botId">): boolean {
  return automation.botId !== undefined;
}

export function routinesOf<T extends Pick<Automation, "botId">>(automations: readonly T[], botId: string): T[] {
  return automations.filter((automation) => automation.botId === botId);
}

/** Why a Bot cannot take another routine, or null when it can. */
export function routineQuotaError(
  automations: readonly Pick<Automation, "botId">[],
  botId: string,
  limits: Pick<RoutineLimits, "perBot"> = ROUTINE_LIMITS,
): string | null {
  if (routinesOf(automations, botId).length < limits.perBot) return null;
  return `A Bot can have at most ${limits.perBot} routines. Delete one to add another.`;
}

/**
 * Why a gap between runs is too short, or null when it is allowed. `minGapMs` is the shortest gap
 * the schedule produces, or null when it has fewer than two runs (a one-shot or an empty schedule).
 */
export function routineSpacingError(
  minGapMs: number | null,
  limits: Pick<RoutineLimits, "minSpacingMinutes"> = ROUTINE_LIMITS,
): string | null {
  if (minGapMs === null) return null;
  if (minGapMs >= limits.minSpacingMinutes * 60_000) return null;
  return `Routines can run at most once every ${limits.minSpacingMinutes} minutes.`;
}

export type RateDecision =
  | { ok: true }
  | { ok: false; scope: "routine" | "account"; retryAfterMs: number };

/** The user-facing reason for a refusal. */
export function describeRateRefusal(decision: Extract<RateDecision, { ok: false }>, limits: RoutineLimits = ROUTINE_LIMITS): string {
  const minutes = Math.max(1, Math.ceil(decision.retryAfterMs / 60_000));
  const when = `Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  return decision.scope === "routine"
    ? `This routine has run ${limits.perHourPerRoutine} times in the last hour. ${when}`
    : `Your routines have run ${limits.perHourAccount} times in the last hour. ${when}`;
}

/**
 * Rolling one-hour run counts, per routine and across all of them. In memory: a restart forgets
 * the window, which only ever lets a few extra runs through, never blocks one.
 */
export class RoutineRateLimiter {
  private readonly byRoutine = new Map<string, number[]>();
  private account: number[] = [];

  constructor(private readonly limits: Pick<RoutineLimits, "perHourAccount" | "perHourPerRoutine"> = ROUTINE_LIMITS) {}

  /** Counts a run when it is allowed; a refused run is not counted. */
  admit(routineId: string, now: number): RateDecision {
    const cutoff = now - HOUR_MS;
    this.account = this.account.filter((at) => at > cutoff);
    const own = (this.byRoutine.get(routineId) ?? []).filter((at) => at > cutoff);

    if (own.length >= this.limits.perHourPerRoutine) {
      this.byRoutine.set(routineId, own);
      return { ok: false, scope: "routine", retryAfterMs: own[0]! + HOUR_MS - now };
    }
    if (this.account.length >= this.limits.perHourAccount) {
      if (own.length === 0) this.byRoutine.delete(routineId);
      else this.byRoutine.set(routineId, own);
      return { ok: false, scope: "account", retryAfterMs: this.account[0]! + HOUR_MS - now };
    }
    own.push(now);
    this.byRoutine.set(routineId, own);
    this.account.push(now);
    return { ok: true };
  }

  /** Drop a deleted routine's window (its runs still count against the account until they age out). */
  forget(routineId: string): void {
    this.byRoutine.delete(routineId);
  }
}
