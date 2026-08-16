import assert from "node:assert/strict";
import test from "node:test";

// Node test environment lacks requestAnimationFrame — polyfill for store batching tests.
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
} from "../src/renderer/hooks/useAgentState.ts";

test("useAgentState: tab switching preserves background thread stream state", async () => {
  __testResetAgentStore();
  const threadA = "thread-a";
  const threadB = "thread-b";

  agentStateStore.startRun(threadA, "agent");
  __testDispatch({ threadId: threadA, event: { type: "text-delta", delta: "Hello " } });
  __testDispatch({ threadId: threadA, event: { type: "text-delta", delta: "world" } });
  await __testFlushRaf();

  const snapA = __testGetThreadState(threadA);
  assert.equal(snapA.running, true);
  assert.equal(snapA.streamText, "Hello world");

  // Thread B idle — no bleed from A
  const snapB = __testGetThreadState(threadB);
  assert.equal(snapB.running, false);
  assert.equal(snapB.streamText, null);

  // A still streaming after "switching away"
  __testDispatch({ threadId: threadA, event: { type: "text-delta", delta: "!" } });
  await __testFlushRaf();
  assert.equal(__testGetThreadState(threadA).streamText, "Hello world!");
});

test("useAgentState: streaming text batches via requestAnimationFrame", async () => {
  __testResetAgentStore();
  const threadId = "batch-thread";
  agentStateStore.startRun(threadId, "agent");

  const seq: number[] = [];
  const unsub = agentStateStore.subscribeStream(threadId, () => {
    seq.push(agentStateStore.getStreamSnapshot(threadId).seq);
  });

  __testDispatch({ threadId, event: { type: "text-delta", delta: "a" } });
  __testDispatch({ threadId, event: { type: "text-delta", delta: "b" } });
  __testDispatch({ threadId, event: { type: "text-delta", delta: "c" } });

  // Before RAF: buffer not flushed to stream snapshot
  assert.equal(agentStateStore.getStreamSnapshot(threadId).streamText, "");

  await __testFlushRaf();
  assert.equal(agentStateStore.getStreamSnapshot(threadId).streamText, "abc");
  assert.ok(seq.length >= 1, "stream listeners notified after RAF batch");

  unsub();
});

test("useAgentState: tool events preserve ordering", () => {
  __testResetAgentStore();
  const threadId = "tool-order";
  agentStateStore.startRun(threadId, "agent");

  __testDispatch({
    threadId,
    event: { type: "tool-start", callId: "c1", name: "read", summary: "file.ts" },
  });
  __testDispatch({
    threadId,
    event: { type: "tool-end", callId: "c1", name: "read", summary: "file.ts", result: "ok", ok: true },
  });

  const events = __testGetThreadState(threadId).runEvents;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "tool");
  if (events[0]?.kind === "tool") {
    assert.equal(events[0].name, "read");
    assert.equal(events[0].ok, true);
  }
});

