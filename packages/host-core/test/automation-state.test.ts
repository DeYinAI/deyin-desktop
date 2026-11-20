import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationStateStore, MAX_STATE_BYTES, stateError } from "../src/automation-state.js";
import { FileStorage, plainCipher } from "../src/storage.js";

const open = (dir = mkdtempSync(join(tmpdir(), "deyin-state-"))) => {
  const storage = new FileStorage(dir, plainCipher);
  return { dir, storage, store: new AutomationStateStore(storage) };
};

test("state is a JSON object of bounded size; anything else is refused with a reason the model can act on", () => {
  assert.equal(stateError({ lastPostedAt: "2026-11-19T10:00:00Z", used: ["a", "b"] }), null);
  assert.match(stateError("a string") ?? "", /must be a JSON object/);
  assert.match(stateError(["a"]) ?? "", /must be a JSON object/);
  assert.match(stateError(null) ?? "", /must be a JSON object/);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.match(stateError(circular) ?? "", /plain JSON/);
  assert.match(stateError({ blob: "x".repeat(MAX_STATE_BYTES) }) ?? "", /limit is 8192/);
  assert.equal(stateError({ blob: "x".repeat(MAX_STATE_BYTES - 20) }), null, "just under the limit is fine");
});

test("the limit counts bytes, not characters", () => {
  assert.match(stateError({ blob: "é".repeat(MAX_STATE_BYTES / 2) }) ?? "", /limit is/);
});

test("each automation keeps its own state, which survives a restart", async () => {
  const { dir, storage: written, store } = open();
  store.set("a", { n: 1 });
  store.set("b", { n: 2 });
  assert.deepEqual(store.get("a"), { n: 1 });
  assert.equal(store.get("nobody"), undefined);
  store.set("a", { n: 3 }); // replaces, does not merge
  assert.deepEqual(store.get("a"), { n: 3 });

  await written.flush();
  const reopened = new AutomationStateStore(new FileStorage(dir, plainCipher));
  assert.deepEqual(reopened.get("a"), { n: 3 });
  assert.deepEqual(reopened.get("b"), { n: 2 });
});

test("a refused state leaves the old one in place", () => {
  const { store } = open();
  store.set("a", { keep: true });
  assert.throws(() => store.set("a", { blob: "x".repeat(MAX_STATE_BYTES) }), /limit is/);
  assert.throws(() => store.set("a", "nope"), /must be a JSON object/);
  assert.deepEqual(store.get("a"), { keep: true });
});

test("what is stored is a copy: changing the caller's object afterwards does not change it", () => {
  const { store } = open();
  const live = { list: [1] };
  store.set("a", live);
  live.list.push(2);
  assert.deepEqual(store.get("a"), { list: [1] });
});

test("removing an automation's state forgets it, and removing nothing is harmless", () => {
  const { store } = open();
  store.set("a", { n: 1 });
  store.remove("a");
  store.remove("a");
  assert.equal(store.get("a"), undefined);
});
