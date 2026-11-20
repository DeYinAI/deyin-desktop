import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecureFormRequest } from "@deyin/host-core/shared";
import { SecureFormBroker } from "../src/main/bots/secure-form-broker.js";

const FORM: SecureFormRequest = {
  title: "Sign-in code",
  reason: "GitHub sent a code to your phone.",
  host: "github.com",
  fields: [
    { id: "code", label: "Code", secret: false },
    { id: "pw", label: "Password", secret: true },
  ],
};

function shown() {
  const seen: Array<{ requestId: string; form: SecureFormRequest }> = [];
  return { seen, show: (requestId: string, form: SecureFormRequest) => void seen.push({ requestId, form }) };
}

test("a form is shown with a request id, and the answer reaches the one waiting", async () => {
  const broker = new SecureFormBroker(5000);
  const { seen, show } = shown();
  const waiting = broker.ask("t1", FORM, show);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.form, FORM);
  assert.equal(broker.size(), 1);
  broker.answer(seen[0]!.requestId, { code: "834201", pw: "hunter2" });
  assert.deepEqual(await waiting, { code: "834201", pw: "hunter2" });
  assert.equal(broker.size(), 0);
});

test("two forms are told apart by request id", async () => {
  const broker = new SecureFormBroker(5000);
  const a = shown();
  const b = shown();
  const first = broker.ask("t1", FORM, a.show);
  const second = broker.ask("t2", FORM, b.show);
  assert.notEqual(a.seen[0]!.requestId, b.seen[0]!.requestId);
  broker.answer(b.seen[0]!.requestId, { code: "2" });
  assert.deepEqual(await second, { code: "2" });
  assert.equal(broker.size(), 1);
  broker.answer(a.seen[0]!.requestId, { code: "1" });
  assert.deepEqual(await first, { code: "1" });
});

test("a cancelled form answers null", async () => {
  const broker = new SecureFormBroker(5000);
  const { seen, show } = shown();
  const waiting = broker.ask("t1", FORM, show);
  broker.answer(seen[0]!.requestId, null);
  assert.equal(await waiting, null);
  assert.equal(broker.size(), 0);
});

test("the answer is cleaned against what was asked: unknown fields, non-text and oversized values are dropped", async () => {
  const broker = new SecureFormBroker(5000);
  const first = shown();
  const waiting = broker.ask("t1", FORM, first.show);
  broker.answer(first.seen[0]!.requestId, { code: "834201", extra: "nope", pw: 5 });
  assert.deepEqual(await waiting, { code: "834201" });
  const second = shown();
  const tooLong = broker.ask("t1", FORM, second.show);
  broker.answer(second.seen[0]!.requestId, { code: "x".repeat(100_000) });
  assert.equal(await tooLong, null, "nothing usable is a cancelled form");
});

test("an answer is used once, and an unknown or malformed request id changes nothing", async () => {
  const broker = new SecureFormBroker(5000);
  const { seen, show } = shown();
  const waiting = broker.ask("t1", FORM, show);
  broker.answer("nope", { code: "1" });
  broker.answer(undefined, { code: "1" });
  broker.answer(42, { code: "1" });
  assert.equal(broker.size(), 1);
  broker.answer(seen[0]!.requestId, { code: "first" });
  broker.answer(seen[0]!.requestId, { code: "second" });
  assert.deepEqual(await waiting, { code: "first" });
});

test("a form nobody answers times out to null and is forgotten", async () => {
  const broker = new SecureFormBroker(20);
  const { show } = shown();
  assert.equal(await broker.ask("t1", FORM, show), null);
  assert.equal(broker.size(), 0);
});

test("stopping a thread cancels its forms and leaves other threads' alone", async () => {
  const broker = new SecureFormBroker(5000);
  const a = shown();
  const b = shown();
  const mine = broker.ask("t1", FORM, a.show);
  const other = broker.ask("t2", FORM, b.show);
  broker.cancelThread("t1");
  assert.equal(await mine, null);
  assert.equal(broker.size(), 1);
  broker.answer(b.seen[0]!.requestId, { code: "7" });
  assert.deepEqual(await other, { code: "7" });
});

test("a form that cannot be shown is cancelled instead of waiting forever", async () => {
  const broker = new SecureFormBroker(60_000);
  const waiting = broker.ask("t1", FORM, () => {
    throw new Error("no window");
  });
  const outcome = await Promise.race([waiting, new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 300))]);
  assert.equal(outcome, null);
  assert.equal(broker.size(), 0);
});

test("an answered form's timer is cleared, so it cannot keep the app waiting", async () => {
  const cleared: unknown[] = [];
  const realClear = globalThis.clearTimeout;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    cleared.push(handle);
    realClear(handle);
  }) as typeof clearTimeout;
  try {
    const broker = new SecureFormBroker(60_000);
    const { seen, show } = shown();
    const waiting = broker.ask("t1", FORM, show);
    broker.answer(seen[0]!.requestId, { code: "1" });
    await waiting;
    assert.equal(cleared.length, 1);
  } finally {
    globalThis.clearTimeout = realClear;
  }
});
