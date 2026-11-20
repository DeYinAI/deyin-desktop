import assert from "node:assert/strict";
import test from "node:test";
import { mergeRunningThreadIds, threadActivity } from "../src/threadActivity.js";

test("a working session shows the spinner, whether or not it is unread", () => {
  assert.equal(threadActivity({ running: true, pending: 0, unread: false }), "running");
  assert.equal(threadActivity({ running: true, pending: 0, unread: true }), "running");
});

test("a finished session the user has not opened shows the unread dot", () => {
  assert.equal(threadActivity({ running: false, pending: 0, unread: true }), "unread");
});

test("a session the user has seen shows nothing", () => {
  assert.equal(threadActivity({ running: false, pending: 0, unread: false }), "idle");
});

test("a run blocked on the user drops the spinner and leaves the pending badge to speak", () => {
  assert.equal(threadActivity({ running: true, pending: 2, unread: true }), "unread");
  assert.equal(threadActivity({ running: true, pending: 1, unread: false }), "idle");
});

test("mergeRunningThreadIds unions agent runs with plain chat and media streams", () => {
  const merged = mergeRunningThreadIds(["agent-a", "both"], { "chat-b": "partial", both: "" });
  assert.deepEqual([...merged].sort(), ["agent-a", "both", "chat-b"]);
});

test("an empty stream string still counts as running (a stream just started)", () => {
  assert.ok(mergeRunningThreadIds([], { fresh: "" }).has("fresh"));
});

test("mergeRunningThreadIds is empty when nothing is in flight", () => {
  assert.equal(mergeRunningThreadIds([], {}).size, 0);
});
