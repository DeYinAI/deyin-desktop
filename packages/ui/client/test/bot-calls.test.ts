import assert from "node:assert/strict";
import test from "node:test";
import { attempt, attemptPlain, reason } from "../src/bots/botCalls.js";

test("a host answer is passed on whole, whether it is a value or a refusal", async () => {
  assert.deepEqual(await attempt(async () => ({ ok: true as const, value: 7 })), { ok: true, value: 7 });
  assert.deepEqual(await attempt(async () => ({ ok: false as const, error: "No such skill." })), { ok: false, error: "No such skill." });
});

test("a call that throws becomes a refusal in words, never a throw", async () => {
  assert.deepEqual(await attempt(async () => Promise.reject(new Error("ipc closed"))), { ok: false, error: "ipc closed" });
  assert.deepEqual(await attemptPlain(async () => Promise.reject(new Error("no host"))), { ok: false, error: "no host" });
  assert.deepEqual(
    await attempt(() => {
      throw new Error("sync failure");
    }),
    { ok: false, error: "sync failure" },
  );
});

test("a plain answer is wrapped as a value", async () => {
  assert.deepEqual(await attemptPlain(async () => ({ steps: 3 })), { ok: true, value: { steps: 3 } });
  assert.deepEqual(await attemptPlain(async () => undefined), { ok: true, value: undefined });
});

test("anything thrown has a reason, even what is not an Error", () => {
  assert.equal(reason(new Error("boom")), "boom");
  assert.equal(reason("plain text"), "plain text");
  assert.equal(reason(42), "42");
  assert.equal(reason(null), "null");
});
