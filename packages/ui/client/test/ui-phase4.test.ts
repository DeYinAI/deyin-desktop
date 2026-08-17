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
} from "../src/hooks/useAgentState.js";

test("useAgentState: getSessionStats returns stable reference between reads", () => {
  __testResetAgentStore();
  const a = agentStateStore.getSessionStats();
  const b = agentStateStore.getSessionStats();
  assert.equal(a, b, "session stats snapshot must be referentially stable for useSyncExternalStore");
});

test("useAgentState: getSnapshot returns stable reference until store notifies", () => {
  __testResetAgentStore();
  const threadId = "stable-thread";
  agentStateStore.startRun(threadId, "agent");
  const a = __testGetThreadState(threadId);
  const b = __testGetThreadState(threadId);
  assert.equal(a, b, "thread snapshot must be referentially stable for useSyncExternalStore");
  __testDispatch({ threadId, event: { type: "tool-start", callId: "c1", name: "read", summary: "file.ts" } });
  const c = __testGetThreadState(threadId);
  assert.notEqual(a, c, "snapshot must change after a structural notify");
});

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


test("useAgentState: tool events carry duration and subagent cards progress", async () => {
  __testResetAgentStore();
  const threadId = "subagent-thread";
  agentStateStore.startRun(threadId, "agent");

  __testDispatch({ threadId, event: { type: "tool-start", callId: "t1", name: "read", summary: "a.ts" } });
  __testDispatch({
    threadId,
    event: { type: "tool-end", callId: "t1", name: "read", summary: "a.ts", result: "ok", ok: true },
  });

  __testDispatch({ threadId, event: { type: "subagent-start", id: "s1", name: "explorer", prompt: "find it" } });
  __testDispatch({ threadId, event: { type: "subagent-progress", id: "s1", line: "grep pattern" } });
  __testDispatch({
    threadId,
    event: { type: "subagent-end", id: "s1", name: "explorer", ok: true, ms: 1500, summary: "found 3 files" },
  });

  const events = __testGetThreadState(threadId).runEvents;
  const tool = events.find((e) => e.kind === "tool");
  assert.ok(tool && tool.kind === "tool" && tool.startedAt !== undefined);
  assert.ok(tool && tool.kind === "tool" && tool.durationMs !== undefined);

  const sub = events.find((e) => e.kind === "subagent");
  assert.ok(sub && sub.kind === "subagent");
  assert.equal(sub.status, "done");
  assert.equal(sub.ms, 1500);
  assert.equal(sub.line, "found 3 files");

  // A failed subagent flips status without losing the last progress line.
  __testDispatch({ threadId, event: { type: "subagent-start", id: "s2", name: "reviewer", prompt: "x" } });
  __testDispatch({ threadId, event: { type: "subagent-progress", id: "s2", line: "read b.ts" } });
  __testDispatch({ threadId, event: { type: "subagent-end", id: "s2", name: "reviewer", ok: false } });
  const failed = __testGetThreadState(threadId).runEvents.find((e) => e.kind === "subagent" && e.id === "s2");
  assert.ok(failed && failed.kind === "subagent" && failed.status === "failed");
  assert.equal(failed.line, "read b.ts");
});
