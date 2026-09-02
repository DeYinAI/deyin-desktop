/**
 * Loop guards: stop a run that has stopped making progress.
 *
 * `maxSteps` is a budget, not a progress check. A model that keeps hitting the
 * same permission denial, re-running the same failing command with reworded
 * arguments, or re-writing a file it already wrote will happily burn the whole
 * budget doing it. These four detectors notice that and redirect the model once,
 * rather than letting it spend forty rounds discovering the same wall.
 *
 * The signature detector deliberately keys on the HOST RESPONSE, not on the
 * arguments: a stuck model rewords arguments cosmetically while hitting the same
 * failure, so matching on arguments misses the loop entirely.
 */

/** What one tool call did, as far as the guards are concerned. */
export interface GuardOutcome {
  toolName: string;
  /** The provider-visible result text. */
  result: string;
  /** False when the tool threw, returned an ERROR:, or was refused. */
  ok: boolean;
  /** The host refused this call (permission, hook, plan mode, evidence gate). */
  denied: boolean;
  /** Raw arguments, used only by the repeat-success detector. */
  argsKey: string;
}

/** A guard firing: the model is told to change approach. */
export interface GuardIntervention {
  code: "storm" | "blocked-streak" | "repeat-success" | "no-progress";
  /** Appended to the first tool result of the batch, or as a host turn. */
  message: string;
  /** Short human-readable line for the UI/telemetry. */
  detail: string;
}

/**
 * Three identical failures is the trip point: two self-corrections are healthy,
 * the third is a death spiral.
 */
export const STORM_THRESHOLD = 3;
/** Three consecutive turns in which the host refused every call. */
export const BLOCKED_STREAK_THRESHOLD = 3;
/** The third identical write-like success in one run is a no-op loop. */
export const REPEAT_SUCCESS_THRESHOLD = 3;
/** Rounds without new evidence before the first (recoverable) nudge. */
export const NO_PROGRESS_NUDGE_ROUNDS = 8;
/** Rounds without new evidence before asking for a fresh plan. */
export const NO_PROGRESS_REPLAN_ROUNDS = 16;

const CHANGE_APPROACH =
  "Change approach: re-sending this — even with the wording changed — will not help, because the calls keep hitting the same outcome. Fix the underlying problem, use a different tool, or explain the blocker in your final answer.";

const RESPECT_BLOCKER =
  "Change approach: do not keep retrying a blocked tool by switching tools, reordering calls, or rewording arguments. Respect the blocker — use an already-allowed tool, ask the user for the specific approval, or explain the blocker in your final answer.";

/**
 * Collapse an error message to a stable category.
 *
 * Two failures of the same kind must produce the same string even when the
 * message embeds a path, a line number, or a timestamp — otherwise a model that
 * retries against a slightly different file escapes the detector.
 */
export function errorCategory(result: string): string {
  const text = result.slice(0, 400).toLowerCase();
  if (text.startsWith("denied:")) return "denied";
  if (text.includes("blocked by hook")) return "hook";
  if (text.includes("delivery gate")) return "gate";
  if (text.includes("not valid json")) return "bad-json";
  if (text.includes("unknown tool")) return "unknown-tool";
  if (text.includes("enoent") || text.includes("no such file")) return "enoent";
  if (text.includes("permission denied") || text.includes("eacces")) return "eacces";
  if (text.includes("timed out") || text.includes("timeout")) return "timeout";
  if (text.includes("not found") || text.includes("no matches")) return "not-found";
  if (text.includes("did not match") || text.includes("occurrences")) return "no-match";
  // Fall back to the leading words, with digits and quoted spans neutralised so
  // "line 42" and "line 91" are the same category.
  return text
    .replace(/["'`][^"'`]*["'`]/g, "_")
    .replace(/\d+/g, "#")
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");
}

/** True when a result string reads as a failure even though the tool returned. */
export function looksFailed(result: string): boolean {
  return result.startsWith("ERROR:") || result.startsWith("Denied:") || result.startsWith("Blocked by hook:");
}

/**
 * Per-run guard state. One instance lives for the length of a `runAgent` call.
 */
export class LoopGuard {
  /** Signature of the last all-failed batch, and how many times it repeated. */
  private stormSignature = "";
  private stormCount = 0;
  /** Consecutive turns in which every call was refused by the host. */
  private blockedStreak = 0;
  /** Identical write-like successes, keyed on tool + arguments. */
  private readonly repeatSuccess = new Map<string, number>();
  /** Rounds since the last new unique read, command, or mutation. */
  private staleRounds = 0;
  /** Evidence seen so far: tool+args pairs that counted as progress. */
  private readonly progressSeen = new Set<string>();
  /** Reset point for the replan nudge, so it fires once per stall. */
  private lastNudgeRound = 0;

  /** Blocks a call before it executes. Returns a refusal message, or null. */
  precheck(toolName: string, argsKey: string, tier: string): string | null {
    if (tier === "read" || tier === "interaction") return null;
    const key = `${toolName}\u0000${argsKey}`;
    const seen = this.repeatSuccess.get(key) ?? 0;
    if (seen < REPEAT_SUCCESS_THRESHOLD - 1) return null;
    return `Blocked by loop guard: this exact ${toolName} call has already succeeded ${seen} times in this run and would be a no-op. ${CHANGE_APPROACH}`;
  }

  /**
   * Record one completed batch and report whether a guard fired.
   *
   * Called once per step, after every tool in the step has run.
   */
  observe(outcomes: readonly GuardOutcome[]): GuardIntervention | null {
    if (outcomes.length === 0) return null;

    // --- Repeat-success bookkeeping (feeds the next step's precheck) --------
    for (const o of outcomes) {
      if (!o.ok) continue;
      const key = `${o.toolName}\u0000${o.argsKey}`;
      this.repeatSuccess.set(key, (this.repeatSuccess.get(key) ?? 0) + 1);
    }

    // --- Progress bookkeeping ----------------------------------------------
    let madeProgress = false;
    for (const o of outcomes) {
      if (!o.ok) continue;
      const key = `${o.toolName}\u0000${o.argsKey}`;
      if (!this.progressSeen.has(key)) {
        this.progressSeen.add(key);
        madeProgress = true;
      }
    }
    this.staleRounds = madeProgress ? 0 : this.staleRounds + 1;

    // --- Blocked streak -----------------------------------------------------
    const allDenied = outcomes.every((o) => o.denied);
    this.blockedStreak = allDenied ? this.blockedStreak + 1 : 0;

    // --- Storm signature ----------------------------------------------------
    const signature = this.batchSignature(outcomes);
    if (signature === null) {
      this.stormSignature = "";
      this.stormCount = 0;
    } else if (signature !== this.stormSignature) {
      this.stormSignature = signature;
      this.stormCount = 1;
    } else {
      this.stormCount += 1;
    }

    // Order matters: report the most specific diagnosis available.
    if (this.stormCount >= STORM_THRESHOLD) {
      const subject =
        outcomes.length > 1
          ? `this batch of ${outcomes.length} tool calls`
          : `"${outcomes[0]!.toolName}"`;
      const advice = outcomes.some((o) => o.denied) ? RESPECT_BLOCKER : CHANGE_APPROACH;
      this.stormCount = 0; // fire once, then give the model room to recover
      return {
        code: "storm",
        message: `[loop guard] ${subject} has now failed ${STORM_THRESHOLD} times in a row with the same host response. ${advice}`,
        detail: `${outcomes[0]!.toolName} hit the same response ${STORM_THRESHOLD}x`,
      };
    }

    if (this.blockedStreak >= BLOCKED_STREAK_THRESHOLD) {
      const streak = this.blockedStreak;
      this.blockedStreak = 0;
      return {
        code: "blocked-streak",
        message: `[loop guard] every tool call in the last ${streak} turns was refused by the host (permission, plan mode, hook, or a delivery gate). ${RESPECT_BLOCKER}`,
        detail: `every call blocked ${streak} turns in a row`,
      };
    }

    if (
      this.staleRounds >= NO_PROGRESS_REPLAN_ROUNDS &&
      this.staleRounds - this.lastNudgeRound >= NO_PROGRESS_NUDGE_ROUNDS
    ) {
      this.lastNudgeRound = this.staleRounds;
      return {
        code: "no-progress",
        message: `[loop guard] ${this.staleRounds} tool-call rounds have produced no new read, command, or change. Stop and re-plan: state what is actually blocking you, then either take a genuinely different action or give your final answer. Do not repeat calls just to reset this check.`,
        detail: `no new evidence for ${this.staleRounds} rounds — asking for a re-plan`,
      };
    }

    if (this.staleRounds === NO_PROGRESS_NUDGE_ROUNDS) {
      this.lastNudgeRound = this.staleRounds;
      return {
        code: "no-progress",
        message: `[loop guard] the last ${NO_PROGRESS_NUDGE_ROUNDS} tool-call rounds produced no new read, command, or change. Reassess before using more tools: finish the current step if it is done, narrow the remaining work, or explain the blocker.`,
        detail: `no new evidence for ${NO_PROGRESS_NUDGE_ROUNDS} rounds`,
      };
    }

    return null;
  }

  /**
   * `(tool, errorCategory)` per call, but only when EVERY call failed — any
   * success means the turn made progress, so the counter resets.
   */
  private batchSignature(outcomes: readonly GuardOutcome[]): string | null {
    const parts: string[] = [];
    for (const o of outcomes) {
      if (o.ok) return null;
      parts.push(o.toolName, errorCategory(o.result));
    }
    return parts.join("\u0000");
  }
}
