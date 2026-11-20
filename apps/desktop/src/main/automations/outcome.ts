import type { AutomationBlocker, AutomationOutcome, AutomationRun } from "@deyin/host-core";
import { classifyError } from "./health.js";
import type { ReportedOutcome } from "./run-tools.js";
import type { TripReason } from "./watchdog.js";

/**
 * Decides what a finished run was. The loop only knows that it stopped; the
 * outcome comes from what the run reported, what cut it short, and — for
 * targets that cannot be asked to report — how it ended.
 */

export interface OutcomeInput {
  /** What the executor returned; absent when the run threw or was abandoned. */
  exec?: { reason: "completed" | "max-steps" | "aborted"; finalText: string };
  report?: ReportedOutcome;
  /** Only runs on this machine can be given `automation_report`; others are judged by how they ended. */
  reportable: boolean;
  tripped?: TripReason;
  /** The word for a user stop (or app quit) in the run's history. */
  stopReason?: string;
  /** The message of an error the run threw. */
  error?: string;
}

export interface ResolvedOutcome {
  status: Extract<AutomationRun["status"], "completed" | "failed" | "aborted">;
  reason: string;
  /** Absent for a run the user stopped: that says nothing about the automation's health. */
  outcome?: AutomationOutcome;
  blocker?: AutomationBlocker;
  artifacts?: string[];
  finalText?: string;
}

function textOf(input: OutcomeInput, report: ReportedOutcome | undefined): string | undefined {
  const spoken = input.exec?.finalText.trim() ?? "";
  if (!report) return spoken || undefined;
  // The report is the run's own statement; what the model said after it is usually "Done."
  return spoken && spoken !== report.summary ? `${report.summary}\n\n${spoken}` : report.summary;
}

/** Why a run that reported was nonetheless cut off, or "" when it ended on its own. */
function cutOffNote(input: OutcomeInput): string {
  if (input.tripped === "timeout" || input.tripped === "stalled") return input.tripped;
  if (input.exec?.reason === "max-steps") return "max-steps";
  return "";
}

export function resolveRunOutcome(input: OutcomeInput): ResolvedOutcome {
  const { report } = input;

  if (input.tripped === "stopped") {
    return { status: "aborted", reason: input.stopReason ?? "stopped", finalText: textOf(input, undefined) };
  }

  if (input.error !== undefined && !report) {
    // An error that is really a blocker (signed out, rate-limited) is recorded as one, so health
    // can tell "needs a sign-in" from "broke".
    const { kind } = classifyError(input.error);
    if (kind !== "other") {
      return { status: "failed", reason: kind === "auth" ? "auth" : `blocked: ${kind}`, outcome: "blocked", blocker: { kind, detail: input.error } };
    }
    return { status: "failed", reason: input.error, outcome: "failed" };
  }

  if (report) {
    const cut = cutOffNote(input);
    const finalText = textOf(input, report);
    const artifacts = report.artifacts;
    switch (report.outcome) {
      case "success":
      case "idle":
        return {
          status: "completed",
          reason: cut ? `completed (${cut} after reporting)` : "completed",
          outcome: report.outcome,
          artifacts,
          finalText,
        };
      case "blocked":
        return { status: "failed", reason: `blocked: ${report.blocker?.kind ?? "other"}`, outcome: "blocked", blocker: report.blocker, artifacts, finalText };
      case "failed":
        return { status: "failed", reason: cut ? `reported failure (${cut})` : "reported failure", outcome: "failed", artifacts, finalText };
      default: {
        const unreachable: never = report.outcome;
        throw new Error(`Unhandled report outcome: ${String(unreachable)}`);
      }
    }
  }

  if (input.tripped) {
    return { status: "failed", reason: input.tripped, outcome: "failed", finalText: textOf(input, undefined) };
  }

  const exec = input.exec;
  if (!exec) return { status: "failed", reason: "run ended without a result", outcome: "failed" };
  if (exec.reason === "aborted") return { status: "aborted", reason: input.stopReason ?? "aborted", finalText: textOf(input, undefined) };
  if (exec.reason === "max-steps") return { status: "failed", reason: "max-steps", outcome: "failed", finalText: textOf(input, undefined) };
  // The agent loop finished on its own.
  return input.reportable
    ? { status: "completed", reason: "completed (no report)", outcome: "unreported", finalText: textOf(input, undefined) }
    : { status: "completed", reason: "completed", outcome: "success", finalText: textOf(input, undefined) };
}
