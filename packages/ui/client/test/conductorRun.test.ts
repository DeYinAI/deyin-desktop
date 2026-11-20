import assert from "node:assert/strict";
import test from "node:test";
import type { ConductorStageProgress, ConductorWorkflowRunState } from "@deyin/contract";
import {
  currentStageIndex,
  formatClock,
  parseConductorRunEvent,
  reduceConductorRun,
  summarizeConductorRun,
  type ConductorRun,
  type ConductorRunEvent,
} from "../src/conductorRun.js";

function stage(id: string, patch: Partial<ConductorStageProgress> = {}): ConductorStageProgress {
  return {
    stageId: id,
    stageName: `Stage ${id}`,
    agentId: "claude",
    status: "queued",
    elapsedMs: 0,
    heartbeatCount: 0,
    toolCallsCount: 0,
    linesProduced: 0,
    ...patch,
  };
}

function runState(patch: Partial<ConductorWorkflowRunState> = {}): ConductorWorkflowRunState {
  return {
    runId: "r1",
    workflowId: "wf",
    workflowName: "Ship it",
    status: "running",
    currentStageIndex: 0,
    stages: [stage("a"), stage("b")],
    startedAt: 1_000,
    totalElapsedMs: 0,
    ...patch,
  };
}

function event(type: ConductorRunEvent["type"], patch: Partial<ConductorRunEvent> = {}): ConductorRunEvent {
  return { type, runId: "r1", workflowId: "wf", ...patch };
}

function started(): ConductorRun {
  const run = reduceConductorRun(null, event("workflow:started", { state: runState() }));
  assert.ok(run);
  return run;
}

test("parseConductorRunEvent keeps workflow events and drops everything else", () => {
  assert.ok(parseConductorRunEvent({ type: "workflow:started", runId: "r1", workflowId: "wf" }));
  assert.equal(parseConductorRunEvent(null), null);
  assert.equal(parseConductorRunEvent("workflow:started"), null);
  assert.equal(parseConductorRunEvent({ type: "workflow:started" }), null);
  assert.equal(parseConductorRunEvent({ type: "stage:bogus", runId: "r1" }), null);
});

test("workflow:started begins a run from the host's state", () => {
  const run = started();
  assert.equal(run.workflowName, "Ship it");
  assert.equal(run.status, "running");
  assert.equal(run.stages.length, 2);
  assert.equal(run.startedAt, 1_000);
});

test("a newer run replaces the tracked one and stale events are ignored", () => {
  const first = started();
  const second = reduceConductorRun(first, event("workflow:started", { runId: "r2", state: runState({ runId: "r2", workflowName: "Other" }) }));
  assert.equal(second?.runId, "r2");
  const late = reduceConductorRun(second, event("stage:completed", { progress: stage("a", { status: "completed" }) }));
  assert.equal(late, second, "events for run r1 must not touch run r2");
});

test("stage progress upserts, and a stall recovers on the next heartbeat", () => {
  let run: ConductorRun | null = started();
  run = reduceConductorRun(run, event("stage:started", { progress: stage("a", { status: "running" }) }));
  assert.equal(run?.stages[0]?.status, "running");

  run = reduceConductorRun(run, event("stage:stalled", { progress: stage("a", { status: "stalled" }) }));
  assert.equal(run?.status, "stalled");

  run = reduceConductorRun(run, event("stage:heartbeat", { progress: stage("a", { status: "running", heartbeatCount: 3 }) }));
  assert.equal(run?.status, "running");
  assert.equal(run?.stages[0]?.heartbeatCount, 3);

  run = reduceConductorRun(run, event("stage:started", { progress: stage("c", { status: "running" }) }));
  assert.equal(run?.stages.length, 3, "an unknown stage is appended");
});

test("completion takes the host's final status, and a finished run ignores late stage events", () => {
  let run: ConductorRun | null = started();
  run = reduceConductorRun(
    run,
    event("workflow:completed", {
      state: runState({ status: "completed", finishedAt: 9_000, stages: [stage("a", { status: "completed" }), stage("b", { status: "completed" })] }),
    }),
  );
  assert.equal(run?.status, "completed");
  assert.equal(run?.finishedAt, 9_000);

  const after = reduceConductorRun(run, event("stage:heartbeat", { progress: stage("a", { status: "running" }) }));
  assert.equal(after, run);
});

test("a completion event without a terminal status is a failure; abort is always aborted", () => {
  const failed = reduceConductorRun(started(), event("workflow:completed", { state: runState({ status: "running" }) }));
  assert.equal(failed?.status, "failed");

  const aborted = reduceConductorRun(started(), event("workflow:aborted", { state: runState({ status: "failed" }) }));
  assert.equal(aborted?.status, "aborted");
});

test("formatClock pads, and grows an hours field only when needed", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(65_000), "1:05");
  assert.equal(formatClock(3_725_000), "1:02:05");
  assert.equal(formatClock(-5), "0:00");
});

test("summaries point at the live stage, then at the outcome", () => {
  let run: ConductorRun | null = started();
  run = reduceConductorRun(
    run,
    event("stage:started", { progress: stage("b", { status: "running", stageName: "Implement", agentId: "codex" }) }),
  );
  assert.ok(run);
  assert.equal(currentStageIndex(run), 1);
  assert.deepEqual(summarizeConductorRun(run, 66_000), { detail: "Stage 2/2 · Implement (codex)", elapsed: "1:05" });

  const failed = reduceConductorRun(
    run,
    event("workflow:completed", {
      state: runState({
        status: "failed",
        finishedAt: 11_000,
        stages: [stage("a", { status: "completed" }), stage("b", { status: "failed", stageName: "Implement", error: "exit 1" })],
      }),
    }),
  );
  assert.ok(failed);
  assert.deepEqual(summarizeConductorRun(failed, 99_000), { detail: "Failed at Implement: exit 1", elapsed: "0:10" });
});
