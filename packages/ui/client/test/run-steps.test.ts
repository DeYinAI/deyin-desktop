import assert from "node:assert/strict";
import test from "node:test";

if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(Date.now()), 0) as unknown as number;
  };
}

import {
  __testDispatch,
  __testFlushRaf,
  __testGetThreadState,
  __testResetAgentStore,
  agentStateStore,
  type AgentSideEffect,
} from "../src/hooks/useAgentState.js";

const toolStart = (callId: string, name: string, summary: string) =>
  ({ type: "tool-start", callId, name, summary }) as const;
const toolEnd = (callId: string, name: string) =>
  ({ type: "tool-end", callId, name, summary: "", result: "ok", ok: true }) as const;

test("rows are stamped with the step that produced them; parallel calls share it", () => {
  __testResetAgentStore();
  const threadId = "steps-stamp";
  agentStateStore.startRun(threadId, "agent");

  __testDispatch({ threadId, event: { type: "step-start", step: 1 } });
  __testDispatch({ threadId, event: toolStart("a", "read", "a.ts") });
  __testDispatch({ threadId, event: toolStart("b", "read", "b.ts") });
  __testDispatch({ threadId, event: toolEnd("a", "read") });
  __testDispatch({ threadId, event: toolEnd("b", "read") });
  __testDispatch({ threadId, event: { type: "step-start", step: 2 } });
  __testDispatch({ threadId, event: toolStart("c", "bash", "ls") });

  const steps = __testGetThreadState(threadId).runEvents.flatMap((e) => (e.kind === "tool" ? [e.step] : []));
  assert.deepEqual(steps, [1, 1, 2]);
});

test("file cards carry the step of the call that made the edit", () => {
  __testResetAgentStore();
  const threadId = "steps-file";
  agentStateStore.startRun(threadId, "agent");

  __testDispatch({ threadId, event: { type: "step-start", step: 3 } });
  __testDispatch({ threadId, event: toolStart("w", "write", "src/a.ts") });
  __testDispatch({ threadId, event: { type: "file-change", path: "/repo/src/a.ts", before: "", after: "x\n" } });

  const file = __testGetThreadState(threadId).runEvents.find((e) => e.kind === "file");
  assert.ok(file && file.kind === "file");
  assert.equal(file.step, 3);
});

test("reasoning is stamped with its step and wall-clock bounds", async () => {
  __testResetAgentStore();
  const threadId = "steps-reasoning";
  agentStateStore.startRun(threadId, "agent");
  const before = Date.now();

  __testDispatch({ threadId, event: { type: "step-start", step: 1 } });
  __testDispatch({ threadId, event: { type: "reasoning-delta", delta: "Considering the options" } });
  __testDispatch({ threadId, event: toolStart("a", "read", "a.ts") });
  await __testFlushRaf();

  const reasoning = __testGetThreadState(threadId).runEvents.find((e) => e.kind === "reasoning");
  assert.ok(reasoning && reasoning.kind === "reasoning");
  assert.equal(reasoning.step, 1);
  assert.ok(reasoning.startedAt !== undefined && reasoning.startedAt >= before);
  assert.ok(reasoning.endedAt !== undefined && reasoning.endedAt >= reasoning.startedAt);
});

test("a new step closes reasoning left over from the previous step under that step's number", () => {
  __testResetAgentStore();
  const threadId = "steps-leftover";
  agentStateStore.startRun(threadId, "agent");

  __testDispatch({ threadId, event: { type: "step-start", step: 1 } });
  __testDispatch({ threadId, event: { type: "reasoning-delta", delta: "No tool call this time" } });
  __testDispatch({ threadId, event: { type: "step-start", step: 2 } });

  const reasoning = __testGetThreadState(threadId).runEvents.filter((e) => e.kind === "reasoning");
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0]!.kind === "reasoning" && reasoning[0]!.step, 1);
});

test("the step does not leak into the next run", () => {
  __testResetAgentStore();
  const threadId = "steps-reset";
  agentStateStore.startRun(threadId, "agent");
  __testDispatch({ threadId, event: { type: "step-start", step: 7 } });
  __testDispatch({ threadId, event: { type: "done", reason: "completed", finalText: "" } });

  agentStateStore.startRun(threadId, "agent");
  __testDispatch({ threadId, event: toolStart("a", "read", "a.ts") });

  const tool = __testGetThreadState(threadId).runEvents.find((e) => e.kind === "tool");
  assert.ok(tool && tool.kind === "tool");
  assert.equal(tool.step, undefined, "rows before the first step-start of a run carry no step");
});

test("done with request stats folds a run-stats line at the end of the run", async () => {
  __testResetAgentStore();
  const threadId = "steps-stats";
  const effects: AgentSideEffect[] = [];
  const off = agentStateStore.onSideEffect((effect) => effects.push(effect));

  agentStateStore.startRun(threadId, "agent");
  __testDispatch({ threadId, event: { type: "step-start", step: 1 } });
  __testDispatch({ threadId, event: { type: "text-delta", delta: "All done." } });
  await __testFlushRaf();
  __testDispatch({
    threadId,
    event: {
      type: "done",
      reason: "completed",
      finalText: "All done.",
      stats: { steps: 1, requests: 2, replays: 1, reviewerCalls: 0 },
    },
  });
  off();

  const complete = effects.find((e) => e.type === "run-complete");
  assert.ok(complete && complete.type === "run-complete");
  const last = complete.fold.events.at(-1);
  assert.deepEqual(last, { kind: "run-stats", steps: 1, requests: 2, replays: 1, reviewerCalls: 0 });
});

test("done without stats (older hosts, runs that sent nothing) adds no run-stats line", () => {
  __testResetAgentStore();
  const threadId = "steps-no-stats";
  const effects: AgentSideEffect[] = [];
  const off = agentStateStore.onSideEffect((effect) => effects.push(effect));

  agentStateStore.startRun(threadId, "agent");
  __testDispatch({ threadId, event: { type: "done", reason: "completed", finalText: "Hi" } });
  off();

  const complete = effects.find((e) => e.type === "run-complete");
  assert.ok(complete && complete.type === "run-complete");
  assert.equal(
    complete.fold.events.some((e) => e.kind === "run-stats"),
    false,
  );
});
