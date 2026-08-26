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

const PLAN_DOC = "# Ship feature\n\n1. Read auth.ts\n2. Patch session cookie\n3. Add tests";

test("mode-changed updates thread mode in the store snapshot", () => {
  __testResetAgentStore();
  const threadId = "mode-thread";
  agentStateStore.startRun(threadId, "agent");
  assert.equal(__testGetThreadState(threadId).mode, "agent");

  __testDispatch({ threadId, event: { type: "mode-changed", mode: "plan" } });
  assert.equal(__testGetThreadState(threadId).mode, "plan");

  __testDispatch({ threadId, event: { type: "mode-changed", mode: "agent" } });
  assert.equal(__testGetThreadState(threadId).mode, "agent");
});

test("plan-mode text-delta routes markdown into planStream after mode-changed", async () => {
  __testResetAgentStore();
  const threadId = "plan-stream-thread";
  agentStateStore.startRun(threadId, "agent");

  __testDispatch({ threadId, event: { type: "mode-changed", mode: "plan" } });
  __testDispatch({ threadId, event: { type: "text-delta", delta: PLAN_DOC } });
  await __testFlushRaf();

  const snap = __testGetThreadState(threadId);
  assert.equal(snap.mode, "plan");
  assert.equal(snap.planStream, PLAN_DOC);
  assert.ok(snap.planStream?.includes("Ship feature"));
});

test("prose before plan heading is kept in planStream once plan shape appears", async () => {
  __testResetAgentStore();
  const threadId = "plan-prose-thread";
  agentStateStore.startRun(threadId, "agent");
  __testDispatch({ threadId, event: { type: "mode-changed", mode: "plan" } });

  __testDispatch({ threadId, event: { type: "text-delta", delta: "Let me outline the approach.\n\n" } });
  await __testFlushRaf();
  assert.equal(__testGetThreadState(threadId).planStream, null);

  __testDispatch({ threadId, event: { type: "text-delta", delta: PLAN_DOC } });
  await __testFlushRaf();
  const snap = __testGetThreadState(threadId);
  assert.ok(snap.planStream?.includes("Let me outline"));
  assert.ok(snap.planStream?.includes("Ship feature"));
});
