import assert from "node:assert/strict";
import test from "node:test";
import { supervise, type Supervision } from "../src/main/automations/watchdog.js";
import { FakeClock, flush } from "./helpers/fake-clock.js";

const SECOND = 1_000;
const limits = { maxMs: 100 * SECOND, idleMs: 30 * SECOND };

/** A run that works until it is told to stop, then winds down by returning. */
const untilAborted =
  (value = "wound-down") =>
  ({ signal }: Supervision): Promise<string> =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve(value), { once: true }));

/** A run stuck in something that never looks at the abort signal. */
const hung = (): Promise<string> => new Promise(() => undefined);

test("a run that ends on its own is returned untouched, and leaves no timers behind", async () => {
  const clock = new FakeClock();
  const result = supervise({ limits, clock, tickMs: SECOND, run: async () => "done" });
  await flush();
  assert.deepEqual(await result, { tripped: undefined, value: "done", abandoned: false });
  assert.equal(clock.pending(), 0);
});

test("a run over its wall-clock limit is aborted and reported as a timeout", async () => {
  const clock = new FakeClock();
  let touch!: () => void;
  const result = supervise({
    limits,
    clock,
    tickMs: SECOND,
    run: (s) => {
      touch = s.touch;
      return untilAborted()(s);
    },
  });
  // Busy the whole time, so only the wall clock can stop it.
  for (let i = 0; i < 99; i += 1) {
    await clock.advance(SECOND);
    touch();
  }
  await clock.advance(SECOND);
  assert.deepEqual(await result, { tripped: "timeout", value: "wound-down", abandoned: false });
  assert.equal(clock.pending(), 0);
});

test("a run that goes quiet is aborted as stalled, measured from its last sign of life", async () => {
  const clock = new FakeClock();
  let touch!: () => void;
  const result = supervise({
    limits,
    clock,
    tickMs: SECOND,
    run: (s) => {
      touch = s.touch;
      return untilAborted()(s);
    },
  });
  await clock.advance(20 * SECOND);
  touch(); // last activity at t=20s, so the quiet period ends at t=50s, not t=30s
  await clock.advance(29 * SECOND);
  let settled = false;
  void result.then(() => (settled = true));
  await flush();
  assert.equal(settled, false, "t=49s: still inside the quiet allowance");
  await clock.advance(SECOND);
  assert.equal((await result).tripped, "stalled");
});

test("steady activity keeps a run alive past what the quiet allowance alone would allow", async () => {
  const clock = new FakeClock();
  let touch!: () => void;
  let finish!: (v: string) => void;
  const result = supervise({
    limits,
    clock,
    tickMs: SECOND,
    run: (s) => {
      touch = s.touch;
      return new Promise<string>((resolve) => (finish = resolve));
    },
  });
  for (let i = 0; i < 90; i += 1) {
    await clock.advance(SECOND);
    if (i % 10 === 0) touch();
  }
  finish("finished");
  assert.deepEqual(await result, { tripped: undefined, value: "finished", abandoned: false });
});

test("a run that ignores the abort is abandoned after the grace period, freeing its slot", async () => {
  const clock = new FakeClock();
  let touch!: () => void;
  const result = supervise({
    limits,
    clock,
    tickMs: SECOND,
    graceMs: 15 * SECOND,
    run: (s) => {
      touch = s.touch;
      return hung();
    },
  });
  for (let i = 0; i < 99; i += 1) {
    await clock.advance(SECOND);
    touch();
  }
  await clock.advance(SECOND); // t=100s: the limit trips and the grace period starts
  await clock.advance(14 * SECOND);
  let settled = false;
  void result.then(() => (settled = true));
  await flush();
  assert.equal(settled, false, "one second of grace left");
  await clock.advance(SECOND);
  assert.deepEqual(await result, { tripped: "timeout", abandoned: true });
  assert.equal(clock.pending(), 0);
});

test("a user stop is a trip of its own kind, and goes through the same grace period", async () => {
  const clock = new FakeClock();
  const user = new AbortController();
  const result = supervise({ limits, clock, tickMs: SECOND, signal: user.signal, run: untilAborted() });
  await clock.advance(5 * SECOND);
  user.abort();
  assert.deepEqual(await result, { tripped: "stopped", value: "wound-down", abandoned: false });

  const stuck = new AbortController();
  const clock2 = new FakeClock();
  const hungResult = supervise({ limits, clock: clock2, tickMs: SECOND, graceMs: 15 * SECOND, signal: stuck.signal, run: hung });
  stuck.abort();
  await flush(); // the grace period starts a moment after the abort
  await clock2.advance(15 * SECOND);
  assert.deepEqual(await hungResult, { tripped: "stopped", abandoned: true });
});

test("a stop requested before the run begins aborts it straight away", async () => {
  const clock = new FakeClock();
  const user = new AbortController();
  user.abort();
  let sawAborted: boolean | undefined;
  const result = await supervise({
    limits,
    clock,
    signal: user.signal,
    run: async (s) => {
      sawAborted = s.signal.aborted;
      return "x";
    },
  });
  assert.equal(sawAborted, true);
  assert.equal(result.tripped, "stopped");
});

test("an error thrown on the way out of an abort is the trip, not a second failure — but an unrelated error still surfaces", async () => {
  const clock = new FakeClock();
  const aborting = supervise({
    limits: { maxMs: 10 * SECOND, idleMs: 10 * SECOND },
    clock,
    tickMs: SECOND,
    run: ({ signal }) =>
      new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("AbortError")), { once: true })),
  });
  await clock.advance(10 * SECOND);
  assert.deepEqual(await aborting, { tripped: "timeout", abandoned: false });

  const failing = supervise({ limits, clock: new FakeClock(), run: async () => Promise.reject(new Error("tool exploded")) });
  await assert.rejects(failing, /tool exploded/);
});
