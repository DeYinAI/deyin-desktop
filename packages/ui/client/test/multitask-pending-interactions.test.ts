import assert from "node:assert/strict";
import test from "node:test";
import {
  countPendingInteractionsByThread,
  countPendingInteractionsForThread,
} from "../src/composerThreadState.js";

test("countPendingInteractionsForThread sums approvals, question and MCP auth", () => {
  const pending = {
    approvalsByThread: {
      "thread-a": [{ requestId: "p1" }, { requestId: "p2" }],
      "thread-b": [{ requestId: "p3" }],
    },
    questionByThread: {
      "thread-a": { requestId: "q1" },
      "thread-c": { requestId: "q2" },
    },
    mcpAuthByThread: {
      "thread-b": [{ moduleId: "cloudflare-docs" }],
    },
  };

  assert.equal(countPendingInteractionsForThread("thread-a", pending), 3);
  assert.equal(countPendingInteractionsForThread("thread-b", pending), 2);
  assert.equal(countPendingInteractionsForThread("thread-c", pending), 1);
  assert.equal(countPendingInteractionsForThread("thread-idle", pending), 0);
});

test("countPendingInteractionsByThread returns per-thread counts for sidebar badges", () => {
  const pending = {
    approvalsByThread: { "a": [{ requestId: "1" }] },
    questionByThread: { "b": { requestId: "q" } },
    mcpAuthByThread: { "a": [{ moduleId: "m1" }, { moduleId: "m2" }] },
  };

  assert.deepEqual(countPendingInteractionsByThread(["a", "b", "c"], pending), {
    a: 3,
    b: 1,
    c: 0,
  });
});

test("empty approval lists and null questions contribute zero", () => {
  const pending = {
    approvalsByThread: { "t": [] },
    questionByThread: { "t": null },
    mcpAuthByThread: {},
  };
  assert.equal(countPendingInteractionsForThread("t", pending), 0);
});

test("question queues count each pending dialog", () => {
  const pending = {
    approvalsByThread: {},
    questionByThread: { "t": [{ requestId: "q1" }, { requestId: "q2" }] },
    mcpAuthByThread: {},
  };
  assert.equal(countPendingInteractionsForThread("t", pending), 2);
});
