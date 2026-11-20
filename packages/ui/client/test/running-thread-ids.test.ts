import assert from "node:assert/strict";
import test from "node:test";

if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(Date.now()), 0) as unknown as number;
  };
}

import { __testDispatch, __testResetAgentStore, agentStateStore } from "../src/hooks/useAgentState.js";

test("getRunningThreadIds lists every running thread and drops each one as it finishes", () => {
  __testResetAgentStore();
  assert.deepEqual(agentStateStore.getRunningThreadIds(), []);

  agentStateStore.startRun("thread-a", "agent");
  agentStateStore.startRun("thread-b", "agent");
  assert.deepEqual([...agentStateStore.getRunningThreadIds()].sort(), ["thread-a", "thread-b"]);

  __testDispatch({ threadId: "thread-a", event: { type: "done", reason: "completed", finalText: "ok" } });
  assert.deepEqual(agentStateStore.getRunningThreadIds(), ["thread-b"]);

  agentStateStore.forceStop("thread-b");
  assert.deepEqual(agentStateStore.getRunningThreadIds(), []);
});

test("getRunningThreadIds keeps its identity while membership is unchanged", () => {
  __testResetAgentStore();
  agentStateStore.startRun("thread-a", "agent");
  const before = agentStateStore.getRunningThreadIds();

  // Tool traffic changes the run but not who is running; a new array here would
  // re-render every sidebar row on each update through useSyncExternalStore.
  __testDispatch({ threadId: "thread-a", event: { type: "tool-start", callId: "c1", name: "read_file", summary: "src/a.ts" } });
  __testDispatch({ threadId: "thread-a", event: { type: "tool-end", callId: "c1", ok: true, result: "done" } });

  assert.equal(agentStateStore.getRunningThreadIds(), before);
});
