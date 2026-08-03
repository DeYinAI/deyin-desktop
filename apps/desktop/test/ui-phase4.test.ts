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
import { groupIntoTurns, partitionTurnZones, searchTurns } from "../src/renderer/hooks/turnGrouping.ts";
import { isQuietTool, countRenderedToolNodes } from "../src/renderer/components/toolCallUtils.ts";

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

test("turnGrouping: groups user → process → assistant", () => {
  const events: ThreadEvent[] = [
    { kind: "user", text: "Fix the bug" },
    { kind: "tool", name: "grep", summary: "search", ok: true },
    { kind: "assistant", text: "Fixed it." },
  ];
  const turns = groupIntoTurns(events);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.user?.text, "Fix the bug");
  assert.equal(turns[0]!.process.length, 1);
  assert.equal(turns[0]!.assistant?.text, "Fixed it.");
});

test("turnGrouping: hot/warm/cold partition", () => {
  const turns = Array.from({ length: 150 }, (_, i) => ({
    index: i,
    user: { kind: "user" as const, text: `Turn ${i}` },
    process: [],
    assistant: { kind: "assistant" as const, text: `Reply ${i}` },
    startEventIndex: i * 2,
  }));
  const zones = partitionTurnZones(turns, 50);
  const hot = zones.find((z) => z.zone === "hot");
  assert.ok(hot);
  assert.equal(hot!.turns.length, 30);
});

test("turnGrouping: search finds matching turns", () => {
  const events: ThreadEvent[] = [
    { kind: "user", text: "alpha" },
    { kind: "assistant", text: "one" },
    { kind: "user", text: "beta" },
    { kind: "assistant", text: "two" },
  ];
  const turns = groupIntoTurns(events);
  const hits = searchTurns(turns, "beta");
  assert.deepEqual(hits, [1]);
});

test("ToolCall quiet mode identifies research tools", () => {
  assert.equal(isQuietTool("read", true), true);
  assert.equal(isQuietTool("grep", true), true);
  assert.equal(isQuietTool("bash", true), false);
  assert.equal(isQuietTool("read", undefined), false);
});

test("ToolCall collapsed state reduces DOM nodes via quiet grouping", () => {
  const events: ThreadEvent[] = Array.from({ length: 100 }, (_, i) => ({
    kind: "tool" as const,
    name: i % 3 === 0 ? "read" : "bash",
    summary: `call-${i}`,
    ok: true,
    result: "done",
  }));
  const rendered = countRenderedToolNodes(events);
  const quietCount = events.filter((e) => e.kind === "tool" && e.name === "read").length;
  assert.ok(rendered < events.length);
  assert.equal(rendered, events.length - quietCount + 1);
});

test("perf: 1000-turn grouping under 2s", () => {
  const events: ThreadEvent[] = [];
  for (let i = 0; i < 1000; i++) {
    events.push({ kind: "user", text: `Question ${i}` });
    events.push({ kind: "assistant", text: `Answer ${i}` });
  }
  const start = performance.now();
  const turns = groupIntoTurns(events);
  partitionTurnZones(turns, 50);
  const elapsed = performance.now() - start;
  assert.equal(turns.length, 1000);
  assert.ok(elapsed < 2000, `1000-turn grouping took ${elapsed.toFixed(0)}ms (target <2000ms)`);
});

test("perf: 100-tool turn grouping", () => {
  const events: ThreadEvent[] = [{ kind: "user", text: "run tools" }];
  for (let i = 0; i < 100; i++) {
    events.push({ kind: "tool", name: "grep", summary: `pattern-${i}`, ok: true });
  }
  events.push({ kind: "assistant", text: "done" });
  const start = performance.now();
  groupIntoTurns(events);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 100, `100-tool turn took ${elapsed.toFixed(1)}ms`);
});
