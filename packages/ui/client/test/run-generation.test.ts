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
} from "../src/hooks/useAgentState.js";

test("stale events are ignored when runId does not match the active run", async () => {
  __testResetAgentStore();
  const threadId = "run-gen-thread";
  const runId = agentStateStore.startRun(threadId, "agent");

  __testDispatch({ threadId, runId, event: { type: "text-delta", delta: "current " } });
  __testDispatch({ threadId, runId: "stale-run-id", event: { type: "text-delta", delta: "stale " } });
  __testDispatch({ threadId, runId, event: { type: "text-delta", delta: "run" } });
  await __testFlushRaf();

  const snap = __testGetThreadState(threadId);
  assert.equal(snap.streamText, "current run");
  assert.equal(snap.runEvents.length, 0, "stale tool events must not append either");
});

test("events without runId still apply (legacy envelopes)", async () => {
  __testResetAgentStore();
  const threadId = "legacy-thread";
  agentStateStore.startRun(threadId, "agent");

  __testDispatch({ threadId, event: { type: "text-delta", delta: "legacy" } });
  await __testFlushRaf();

  assert.equal(__testGetThreadState(threadId).streamText, "legacy");
});

test("a new startRun resets runId so prior run envelopes are ignored", async () => {
  __testResetAgentStore();
  const threadId = "restart-thread";
  const firstRunId = agentStateStore.startRun(threadId, "agent");
  __testDispatch({ threadId, runId: firstRunId, event: { type: "text-delta", delta: "first" } });
  await __testFlushRaf();

  const secondRunId = agentStateStore.startRun(threadId, "agent");
  assert.notEqual(firstRunId, secondRunId);

  __testDispatch({ threadId, runId: firstRunId, event: { type: "text-delta", delta: " bleed" } });
  __testDispatch({ threadId, runId: secondRunId, event: { type: "text-delta", delta: "second" } });
  await __testFlushRaf();

  assert.equal(__testGetThreadState(threadId).streamText, "second");
});

test("stale tool-start is ignored when runId mismatches", () => {
  __testResetAgentStore();
  const threadId = "tool-run-id";
  const runId = agentStateStore.startRun(threadId, "agent");

  __testDispatch({
    threadId,
    runId: "old-run",
    event: { type: "tool-start", callId: "c1", name: "read", summary: "stale.ts" },
  });
  __testDispatch({
    threadId,
    runId,
    event: { type: "tool-start", callId: "c2", name: "read", summary: "current.ts" },
  });

  const snap = __testGetThreadState(threadId);
  assert.equal(snap.runEvents.length, 1);
  assert.equal(snap.runEvents[0]?.kind, "tool");
  if (snap.runEvents[0]?.kind === "tool") {
    assert.equal(snap.runEvents[0].summary, "current.ts");
  }
});
