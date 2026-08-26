import assert from "node:assert/strict";
import test from "node:test";
import {
  countPendingInteractionsForThread,
  pickRunningThreadToStop,
  resolveChatStreamText,
  shouldQueueFollowUp,
  shouldShowGlobalStop,
} from "../src/composerThreadState.js";

test("shouldQueueFollowUp: queues only when the target thread is running or busy", () => {
  assert.equal(
    shouldQueueFollowUp({
      threadId: "thread-b",
      isThreadRunning: false,
      streamText: null,
      busyThreadId: null,
    }),
    false,
  );
  assert.equal(
    shouldQueueFollowUp({
      threadId: "thread-a",
      isThreadRunning: true,
      streamText: null,
      busyThreadId: null,
    }),
    true,
  );
  assert.equal(
    shouldQueueFollowUp({
      threadId: "thread-b",
      isThreadRunning: false,
      streamText: "partial",
      busyThreadId: "thread-a",
    }),
    false,
  );
  assert.equal(
    shouldQueueFollowUp({
      threadId: "thread-a",
      isThreadRunning: false,
      streamText: "Generating image…",
      busyThreadId: "thread-a",
    }),
    true,
  );
});

test("resolveChatStreamText: composer-busy stream stays on owning thread", () => {
  assert.equal(
    resolveChatStreamText({
      activeThreadId: "thread-b",
      agentStreamText: null,
      streamText: "hello",
      busyThreadId: "thread-a",
    }),
    null,
  );
  assert.equal(
    resolveChatStreamText({
      activeThreadId: "thread-a",
      agentStreamText: null,
      streamText: "hello",
      busyThreadId: "thread-a",
    }),
    "hello",
  );
  assert.equal(
    resolveChatStreamText({
      activeThreadId: "thread-a",
      agentStreamText: "agent text",
      streamText: "plain",
      busyThreadId: "thread-b",
    }),
    "agent text",
  );
});

test("pickRunningThreadToStop: prefers active thread when it is running or busy", () => {
  assert.equal(
    pickRunningThreadToStop({
      activeThreadId: "thread-b",
      runningThreadId: "thread-a",
      isActiveThreadRunning: true,
      isActiveComposerBusy: false,
    }),
    "thread-b",
  );
  assert.equal(
    pickRunningThreadToStop({
      activeThreadId: "thread-b",
      runningThreadId: "thread-a",
      isActiveThreadRunning: false,
      isActiveComposerBusy: true,
    }),
    "thread-b",
  );
  assert.equal(
    pickRunningThreadToStop({
      activeThreadId: "thread-b",
      runningThreadId: "thread-a",
      isActiveThreadRunning: false,
      isActiveComposerBusy: false,
    }),
    "thread-a",
  );
});

test("shouldShowGlobalStop: any running thread or active streaming", () => {
  assert.equal(
    shouldShowGlobalStop({ runningThreadId: "thread-a", isActiveThreadStreaming: false }),
    true,
  );
  assert.equal(
    shouldShowGlobalStop({ runningThreadId: null, isActiveThreadStreaming: true }),
    true,
  );
  assert.equal(
    shouldShowGlobalStop({ runningThreadId: null, isActiveThreadStreaming: false }),
    false,
  );
});

test("countPendingInteractionsForThread supports question queues", () => {
  const pending = {
    approvalsByThread: { t: [{ id: 1 }] },
    questionByThread: { t: [{ id: 1 }, { id: 2 }] },
    mcpAuthByThread: {},
  };
  assert.equal(countPendingInteractionsForThread("t", pending), 3);
});
