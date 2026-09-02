import assert from "node:assert/strict";
import { test } from "node:test";
import { RawResultStore } from "../src/raw-results.js";

test("records and returns the raw pre-snip bytes by tool_call_id", () => {
  const store = new RawResultStore();
  store.record("call_1", "bash", "HEAD" + "x".repeat(90_000) + "TAIL");
  const raw = store.get("call_1");
  assert.ok(raw, "the snipped result must be retrievable");
  assert.equal(raw!.toolName, "bash");
  assert.ok(raw!.content.startsWith("HEAD"));
  assert.ok(raw!.content.endsWith("TAIL"));
  assert.equal(raw!.content.length, 90_000 + 8);
});

test("evicts the oldest entries beyond maxEntries", () => {
  const store = new RawResultStore(2, 1_000_000);
  store.record("c1", "read", "one");
  store.record("c2", "read", "two");
  store.record("c3", "read", "three");
  assert.equal(store.get("c1"), undefined, "oldest must be evicted");
  assert.ok(store.get("c2"));
  assert.ok(store.get("c3"));
  assert.equal(store.evictedCount, 1);
});

test("evicts until the total character budget fits", () => {
  const store = new RawResultStore(10, 50);
  store.record("c1", "read", "x".repeat(40));
  store.record("c2", "read", "y".repeat(40));
  // c2 alone (40) fits with nothing else; c1 had to go.
  assert.equal(store.get("c1"), undefined);
  assert.ok(store.get("c2"));
  assert.ok(store.evictedCount >= 1);
});

test("a result that cannot fit even alone is not stored", () => {
  const store = new RawResultStore(10, 100);
  store.record("c1", "read", "x".repeat(101));
  assert.equal(store.get("c1"), undefined);
  assert.equal(store.size, 0);
});

test("re-recording the same id replaces instead of double-counting", () => {
  const store = new RawResultStore(10, 100);
  store.record("c1", "read", "x".repeat(40));
  store.record("c1", "bash", "y".repeat(30));
  assert.equal(store.size, 1);
  const raw = store.get("c1");
  assert.equal(raw!.toolName, "bash");
  assert.equal(raw!.content, "y".repeat(30));
});

test("a re-recorded id is the most recently used for eviction", () => {
  const store = new RawResultStore(2, 1_000_000);
  store.record("c1", "read", "one");
  store.record("c2", "read", "two");
  store.record("c1", "read", "one-updated"); // touches c1, c2 is now oldest
  store.record("c3", "read", "three");
  assert.equal(store.get("c2"), undefined, "the untouched entry should be evicted first");
  assert.equal(store.get("c1")!.content, "one-updated");
});
