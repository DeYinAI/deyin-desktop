/**
 * Client-side model of a Conductor pipeline run: the host streams workflow
 * events, this folds them into one `ConductorRun` that the run strip (above the
 * composer) and the Pipeline monitor tab both render.
 */
import type { ConductorStageProgress, ConductorWorkflowRunState } from "@deyin/contract";

export type ConductorRunStatus = ConductorWorkflowRunState["status"];

const CONDUCTOR_RUN_EVENT_TYPES = [
  "workflow:started",
  "stage:started",
  "stage:heartbeat",
  "stage:stalled",
  "stage:completed",
  "stage:failed",
  "workflow:completed",
  "workflow:aborted",
] as const;

export type ConductorRunEventType = (typeof CONDUCTOR_RUN_EVENT_TYPES)[number];

/** Structural mirror of the host's `WorkflowEvent` (the IPC bridge types it as `any`). */
export interface ConductorRunEvent {
  type: ConductorRunEventType;
  runId: string;
  workflowId: string;
  progress?: ConductorStageProgress;
  state?: ConductorWorkflowRunState;
  message?: string;
  error?: string;
}

export interface ConductorRun {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: ConductorRunStatus;
  stages: ConductorStageProgress[];
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/** Narrow an untyped IPC payload; anything that is not a workflow event is dropped. */
export function parseConductorRunEvent(raw: unknown): ConductorRunEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<ConductorRunEvent>;
  if (typeof candidate.runId !== "string" || typeof candidate.type !== "string") return null;
  if (!CONDUCTOR_RUN_EVENT_TYPES.some((type) => type === candidate.type)) return null;
  return candidate as ConductorRunEvent;
}

export function isConductorRunActive(status: ConductorRunStatus): boolean {
  return status === "running" || status === "stalled";
}

function isTerminal(status: ConductorRunStatus | undefined): status is "completed" | "failed" | "aborted" {
  return status === "completed" || status === "failed" || status === "aborted";
}

function upsertStage(stages: ConductorStageProgress[], progress: ConductorStageProgress): ConductorStageProgress[] {
  const index = stages.findIndex((s) => s.stageId === progress.stageId);
  if (index === -1) return [...stages, progress];
  const next = stages.slice();
  next[index] = progress;
  return next;
}

/**
 * Fold one host event into the tracked run. Only the latest run is tracked:
 * `workflow:started` replaces it, and events for any other run are ignored.
 */
export function reduceConductorRun(run: ConductorRun | null, event: ConductorRunEvent): ConductorRun | null {
  switch (event.type) {
    case "workflow:started":
      return {
        runId: event.runId,
        workflowId: event.workflowId,
        workflowName: event.state?.workflowName ?? event.workflowId,
        status: "running",
        stages: event.state?.stages ?? [],
        startedAt: event.state?.startedAt ?? Date.now(),
      };
    case "stage:started":
    case "stage:heartbeat":
    case "stage:stalled":
    case "stage:completed":
    case "stage:failed": {
      if (!run || run.runId !== event.runId || isTerminal(run.status)) return run;
      const stages = event.progress ? upsertStage(run.stages, event.progress) : run.stages;
      // A heartbeat (or any progress) after a stall means the stage recovered.
      const status: ConductorRunStatus = event.type === "stage:stalled" ? "stalled" : "running";
      return { ...run, stages, status };
    }
    case "workflow:completed":
    case "workflow:aborted": {
      if (!run || run.runId !== event.runId) return run;
      const reported = event.state?.status;
      const status: ConductorRunStatus =
        event.type === "workflow:aborted" ? "aborted" : isTerminal(reported) ? reported : "failed";
      return {
        ...run,
        status,
        stages: event.state?.stages ?? run.stages,
        finishedAt: event.state?.finishedAt ?? Date.now(),
        error: event.state?.error ?? event.error,
      };
    }
    default: {
      const unhandled: never = event.type;
      throw new Error(`Unhandled conductor run event: ${String(unhandled)}`);
    }
  }
}

/** `mm:ss`, or `h:mm:ss` once a run passes the hour. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** The stage to talk about: the live one, else the next queued, else the last. */
export function currentStageIndex(run: ConductorRun): number {
  const live = run.stages.findIndex((s) => s.status === "running" || s.status === "stalled");
  if (live !== -1) return live;
  const queued = run.stages.findIndex((s) => s.status === "queued");
  if (queued !== -1 && !isTerminal(run.status)) return queued;
  return Math.max(0, run.stages.length - 1);
}

export interface ConductorRunSummary {
  /** One short sentence for the run strip. */
  detail: string;
  elapsed: string;
}

export function summarizeConductorRun(run: ConductorRun, now: number): ConductorRunSummary {
  const total = run.stages.length;
  const index = currentStageIndex(run);
  const stage = run.stages[index];
  const position = total > 0 ? `Stage ${index + 1}/${total}` : "Starting";
  const stageLabel = stage ? `${position} · ${stage.stageName} (${stage.agentId})` : position;
  const done = run.stages.filter((s) => s.status === "completed").length;

  switch (run.status) {
    case "idle":
      return { detail: "Queued", elapsed: formatClock(0) };
    case "running":
      return { detail: stageLabel, elapsed: formatClock(now - run.startedAt) };
    case "stalled":
      return { detail: `${stageLabel} is not responding`, elapsed: formatClock(now - run.startedAt) };
    case "completed":
      return { detail: `Finished · ${done}/${total} stages`, elapsed: formatClock((run.finishedAt ?? now) - run.startedAt) };
    case "failed": {
      const failed = run.stages.find((s) => s.status === "failed");
      const reason = failed?.error ?? run.error;
      const where = failed ? `Failed at ${failed.stageName}` : "Failed";
      return {
        detail: reason ? `${where}: ${reason}` : where,
        elapsed: formatClock((run.finishedAt ?? now) - run.startedAt),
      };
    }
    case "aborted":
      return { detail: `Stopped · ${done}/${total} stages done`, elapsed: formatClock((run.finishedAt ?? now) - run.startedAt) };
    default: {
      const unhandled: never = run.status;
      throw new Error(`Unhandled conductor run status: ${String(unhandled)}`);
    }
  }
}
