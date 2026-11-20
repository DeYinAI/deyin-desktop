import type { ToolDefinition } from "@deyin/agent-core";
import {
  BLOCKER_KINDS,
  formatDuration,
  isBlockerKind,
  type AutomationBlocker,
  type AutomationLimits,
  type AutomationOutcome,
} from "@deyin/host-core";

/**
 * The two tools only an unattended automation run has.
 *
 * `automation_report` is how a run says what happened. Without it the runner
 * could only guess from "the model stopped talking" — which is how a run that
 * had hit a login wall counted as a success. `run_clock` lets a long task pace
 * itself against the limits that will cut it off.
 */

/** What a run can report. `unreported` is the runner's word for a run that never did. */
export type ReportableOutcome = Exclude<AutomationOutcome, "unreported">;
export const REPORT_OUTCOMES: readonly ReportableOutcome[] = ["success", "idle", "blocked", "failed"];

export interface ReportedOutcome {
  outcome: ReportableOutcome;
  summary: string;
  blocker?: AutomationBlocker;
  artifacts?: string[];
}

const MAX_SUMMARY = 1_500;
const MAX_DETAIL = 400;
const MAX_ARTIFACTS = 20;
const MAX_ARTIFACT_CHARS = 300;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Validates a report; throws a message the model can act on, so it retries correctly. */
export function parseReport(args: Record<string, unknown>): ReportedOutcome {
  const outcome = text(args.outcome);
  if (!(REPORT_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error(`outcome must be one of: ${REPORT_OUTCOMES.join(", ")}.`);
  }
  const summary = text(args.summary);
  if (!summary) throw new Error("summary is required: say what happened, in a sentence or two.");

  const report: ReportedOutcome = {
    outcome: outcome as ReportableOutcome,
    summary: summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY)}…` : summary,
  };

  if (report.outcome === "blocked") {
    const raw = args.blocker;
    const blocker = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
    const kind = text(blocker?.kind);
    if (!isBlockerKind(kind)) throw new Error(`A blocked report needs blocker.kind, one of: ${BLOCKER_KINDS.join(", ")}.`);
    const detail = text(blocker?.detail);
    if (!detail) throw new Error("A blocked report needs blocker.detail: what exactly stopped you.");
    report.blocker = { kind, detail: detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail };
  }

  if (Array.isArray(args.artifacts)) {
    const artifacts = args.artifacts
      .map(text)
      .filter((a) => a.length > 0)
      .slice(0, MAX_ARTIFACTS)
      .map((a) => (a.length > MAX_ARTIFACT_CHARS ? `${a.slice(0, MAX_ARTIFACT_CHARS)}…` : a));
    if (artifacts.length > 0) report.artifacts = artifacts;
  }
  return report;
}

export interface RunClock {
  startedAt: number;
  limits: AutomationLimits;
  /** Model steps taken so far. */
  steps: () => number;
  now?: () => number;
}

/** "Elapsed 4m 10s of 15m (10m 50s left). Step 37 of 120." */
export function describeClock(clock: RunClock): string {
  const now = (clock.now ?? Date.now)();
  const budgetMs = clock.limits.maxMinutes * 60_000;
  const elapsed = Math.max(0, now - clock.startedAt);
  const left = budgetMs - elapsed;
  const time = left > 0 ? `${formatDuration(left)} left` : "over the time limit — wrap up now";
  return `Elapsed ${formatDuration(elapsed)} of ${clock.limits.maxMinutes}m (${time}). Step ${clock.steps()} of ${clock.limits.maxSteps}.`;
}

/** This automation's saved state: a small JSON object that survives from one run to the next. */
export interface AutomationStateAccess {
  get(): Record<string, unknown> | undefined;
  /** Replaces the whole state; throws a message the model can act on when it cannot be stored. */
  set(value: unknown): void;
}

export interface RunTools {
  tools: ToolDefinition[];
  /** The last report the run made, if any. */
  reported(): ReportedOutcome | undefined;
}

export function createRunTools(clock: RunClock, state?: AutomationStateAccess): RunTools {
  let reported: ReportedOutcome | undefined;

  const reportTool: ToolDefinition = {
    name: "automation_report",
    description:
      "Report how this run ended. Call it once, as your last action. outcome: success (the task was done), idle (nothing needed doing), blocked (something outside your control stopped you — give blocker.kind and blocker.detail), or failed (you tried and it did not work). Report what actually happened; do not report success for anything you did not verify.",
    tier: "read",
    parameters: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: [...REPORT_OUTCOMES], description: "How the run ended." },
        summary: { type: "string", description: "What you did or what happened, with the links or ids of anything you produced." },
        blocker: {
          type: "object",
          description: "Required when outcome is blocked.",
          properties: {
            kind: { type: "string", enum: [...BLOCKER_KINDS], description: "What kind of obstacle." },
            detail: { type: "string", description: "What exactly stopped you (the page you saw, the error you got)." },
          },
          required: ["kind", "detail"],
        },
        artifacts: { type: "array", items: { type: "string" }, description: "Files, URLs or ids this run produced." },
      },
      required: ["outcome", "summary"],
    },
    summarize: (args) => `report ${text(args.outcome) || "outcome"}`,
    execute: async (args) => {
      reported = parseReport(args);
      return `Recorded: ${reported.outcome}. Your run is complete; do not take further actions.`;
    },
  };

  const clockTool: ToolDefinition = {
    name: "run_clock",
    description: "How much of this run's time and step budget is used. The run is cut off when a limit is reached, so check it before starting a long step.",
    tier: "read",
    parameters: { type: "object", properties: {}, required: [] },
    summarize: () => "check run clock",
    execute: async () => describeClock(clock),
  };

  const stateTool: ToolDefinition = {
    name: "automation_state",
    description:
      "This automation's own memory between runs: one small JSON object (8 KB at most) that is shown to you at the start of every run. Keep in it what the next run needs and could not otherwise know — what you already did, so you do not repeat it. action=get returns it; action=set replaces all of it with `value`. Never store secrets.",
    tier: "write",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], description: "get reads the saved state; set replaces it." },
        value: { type: "object", description: "For set: the complete new state, as a JSON object." },
      },
      required: ["action"],
    },
    summarize: (args) => `automation state ${text(args.action) || "?"}`,
    execute: async (args) => {
      const action = text(args.action);
      if (action === "get") {
        const saved = state?.get();
        return saved ? JSON.stringify(saved, null, 2) : "Nothing saved yet.";
      }
      if (action === "set") {
        if (!state) throw new Error("This run has no saved state.");
        state.set(args.value);
        return "Saved. The next run will see it.";
      }
      throw new Error("action must be get or set.");
    },
  };

  return { tools: [clockTool, reportTool, ...(state ? [stateTool] : [])], reported: () => reported };
}
