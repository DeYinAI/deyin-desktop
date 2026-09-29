/**
 * How the agent loop's interventions read to a person.
 *
 * The loop talks to hosts through two event kinds that are easy to mislabel:
 *
 * - `evidence-gate` carries two unrelated things: delivery-mode gates (the run is
 *   being held to a verification standard — worth a red flag) and the loop nudging
 *   the model to carry on (the run is healthy; the host is just pushing it along).
 *   Rendering both as "Delivery gate — step not verifiable yet" told people their
 *   work was broken while the agent was in fact being kept going.
 * - `stream-retry` is the loop replaying a step after a model-connection hiccup.
 *
 * Pure and browser-safe (no `node:` imports) so the desktop/web renderer and the
 * CLI word these identically.
 */

export type RunNoticeTone = "error" | "notice";

export interface RunNotice {
  /** `error` for delivery gates that block work; `notice` for everything informational. */
  tone: RunNoticeTone;
  /** One line for the timeline. */
  text: string;
}

/** Delivery-mode gates: the run is held until evidence requirements are met. */
const DELIVERY_GATE_CODES = [
  "no_todos",
  "no_acceptance_criteria",
  "unsigned_steps",
  "unverified_mutations",
  "incomplete_todos",
] as const;

/** The loop pushing the model to keep going, or handing it something to fix. */
const NUDGE_GATE_CODES = [
  "unfinished_turn",
  "empty_response",
  "output_truncated",
  "open_todos",
  "unverified_goal",
  "compiler_diagnostics",
] as const;

type KnownGateCode = (typeof DELIVERY_GATE_CODES)[number] | (typeof NUDGE_GATE_CODES)[number];

function isKnownGateCode(code: string): code is KnownGateCode {
  return (DELIVERY_GATE_CODES as readonly string[]).includes(code) || (NUDGE_GATE_CODES as readonly string[]).includes(code);
}

/** The host wraps loop-guard interventions on the gate channel as `loop-guard:<code>`. */
const LOOP_GUARD_PREFIX = "loop-guard:";

/** Drop sentence-final punctuation so a suffix can be appended without a stray full stop. */
function stripTrailingPeriod(text: string): string {
  return text.trim().replace(/[.。]+$/u, "");
}

function deliveryGate(code: string): RunNotice {
  return { tone: "error", text: `Delivery gate (${code}) — step not verifiable yet` };
}

/**
 * Timeline line for an `evidence-gate` event.
 *
 * A code this renderer has never heard of (a newer core than the UI) keeps the
 * original delivery-gate reading: that is what every gate used to look like, so
 * it is the least surprising fallback.
 */
export function describeEvidenceGate(code: string, message: string): RunNotice {
  if (code.startsWith(LOOP_GUARD_PREFIX)) {
    const detail = stripTrailingPeriod(message);
    return { tone: "notice", text: detail ? `Loop guard — ${detail}` : "Loop guard redirected the model" };
  }
  if (!isKnownGateCode(code)) return deliveryGate(code);

  switch (code) {
    case "no_todos":
    case "no_acceptance_criteria":
    case "unsigned_steps":
    case "unverified_mutations":
    case "incomplete_todos":
      return deliveryGate(code);
    case "unfinished_turn":
    case "empty_response":
    case "output_truncated":
      // The loop's own sentence already says what happened and what it did about it.
      return { tone: "notice", text: stripTrailingPeriod(message) || "The model stopped early; asked it to continue" };
    case "open_todos":
      return { tone: "notice", text: `${stripTrailingPeriod(message) || "Todos still open"} — asked the model to finish them` };
    case "unverified_goal":
      return { tone: "notice", text: "Goal not yet reported as met — asked the model to verify it or keep working" };
    case "compiler_diagnostics":
      return { tone: "notice", text: `${stripTrailingPeriod(message) || "Diagnostics found"} — sent to the model to fix` };
    default: {
      const unreachable: never = code;
      return unreachable;
    }
  }
}

export interface StreamRetryNotice {
  attempt: number;
  maxAttempts: number;
  reason: string;
  delayMs: number;
}

/** "The provider returned HTTP 503 — retrying in 2s (2/5)". */
export function describeStreamRetry(retry: StreamRetryNotice): string {
  const seconds = Math.max(1, Math.round(retry.delayMs / 1000));
  return `${stripTrailingPeriod(retry.reason) || "The connection to the model was interrupted"} — retrying in ${seconds}s (${retry.attempt}/${retry.maxAttempts})`;
}
