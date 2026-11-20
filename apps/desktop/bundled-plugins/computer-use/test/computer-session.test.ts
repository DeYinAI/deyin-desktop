import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { ComputerUseState } from "@deyin/contract";
import { ComputerUseSession, ComputerUseStoppedError } from "../host/computer-session.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function record(session: ComputerUseSession): ComputerUseState[] {
  const seen: ComputerUseState[] = [];
  session.onState((s) => seen.push(s));
  return seen;
}

test("a session is idle until an action runs, then background, then idle again", async () => {
  const session = new ComputerUseSession();
  const seen = record(session);
  assert.deepEqual(session.state(), { phase: "idle" });
  assert.equal(session.active, false);

  const gate = deferred();
  const running = session.run({ app: "notepad", action: "click s1e2" }, () => gate.promise);
  await tick();
  assert.deepEqual(session.state(), { phase: "background", app: "notepad", action: "click s1e2" });
  assert.equal(session.active, true);

  gate.resolve();
  await running;
  assert.deepEqual(session.state(), { phase: "idle" });
  assert.deepEqual(seen.map((s) => s.phase), ["background", "idle"]);
});

test("run returns the action's value and passes it a signal", async () => {
  const session = new ComputerUseSession();
  const value = await session.run({ action: "x" }, async (signal) => {
    assert.equal(signal.aborted, false);
    return 42;
  });
  assert.equal(value, 42);
});

test("raw input from the host moves the phase to input, with the point, and back", async () => {
  const session = new ComputerUseSession();
  const seen = record(session);
  const gate = deferred();
  const running = session.run({ app: "notepad", action: "click" }, () => gate.promise);
  await tick();
  session.setRawInput(true, { x: 10, y: 20 });
  assert.deepEqual(session.state(), { phase: "input", app: "notepad", action: "click", point: { x: 10, y: 20 } });
  session.setRawInput(false);
  assert.equal(session.state().phase, "background");
  assert.equal(session.state().point, undefined);
  gate.resolve();
  await running;
  assert.deepEqual(seen.map((s) => s.phase), ["background", "input", "background", "idle"]);
});

test("raw input reported while nothing is running is ignored", () => {
  const session = new ComputerUseSession();
  session.setRawInput(true, { x: 1, y: 2 });
  assert.deepEqual(session.state(), { phase: "idle" });
});

test("identical states are not sent twice", async () => {
  const session = new ComputerUseSession();
  const seen = record(session);
  const gate = deferred();
  const running = session.run({ app: "a", action: "x" }, () => gate.promise);
  await tick();
  session.setRawInput(false); // no change
  session.setRawInput(false);
  gate.resolve();
  await running;
  assert.deepEqual(seen.map((s) => s.phase), ["background", "idle"]);
});

test("stop aborts the action in flight", async () => {
  const session = new ComputerUseSession();
  let sawAbort = false;
  const running = session.run({ action: "long" }, (signal) => {
    return new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
        reject(new ComputerUseStoppedError());
      });
    });
  });
  await tick();
  session.stop();
  await assert.rejects(running, ComputerUseStoppedError);
  assert.equal(sawAbort, true);
  assert.deepEqual(session.state(), { phase: "idle" });
});

test("stop is safe when idle, and the next action runs normally", async () => {
  const session = new ComputerUseSession();
  session.stop();
  assert.equal(await session.run({ action: "after" }, async () => "ok"), "ok");
});

test("one stop aborts every action in flight", async () => {
  const session = new ComputerUseSession();
  const aborted: boolean[] = [];
  const make = () =>
    session.run({ action: "a" }, (signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => (aborted.push(true), resolve()))));
  const a = make();
  const b = make();
  await tick();
  session.stop();
  await Promise.all([a, b]);
  assert.equal(aborted.length, 2);
});

test("the run's own cancellation stops the action the same way", async () => {
  const session = new ComputerUseSession();
  const outer = new AbortController();
  const running = session.run(
    { action: "x" },
    (signal) => new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new ComputerUseStoppedError()))),
    outer.signal,
  );
  await tick();
  outer.abort();
  await assert.rejects(running, ComputerUseStoppedError);
});

test("an already-cancelled run never starts the action", async () => {
  const session = new ComputerUseSession();
  const outer = new AbortController();
  outer.abort();
  let ran = false;
  await assert.rejects(
    session.run({ action: "x" }, async () => ((ran = true), 1), outer.signal),
    ComputerUseStoppedError,
  );
  assert.equal(ran, false);
});

test("after a takeover the next action waits until the user resumes", async () => {
  const session = new ComputerUseSession();
  const seen = record(session);
  session.pause();
  assert.equal(session.state().phase, "paused");
  assert.equal(session.isPaused, true);

  let started = false;
  const next = session.run({ app: "notepad", action: "click" }, async () => {
    started = true;
    return "done";
  });
  await tick();
  assert.equal(started, false, "must not act while the user has control");
  assert.equal(session.state().phase, "paused");

  session.resume();
  assert.equal(await next, "done");
  assert.equal(started, true);
  // paused, the waiting action's label arrives while still paused, then resumed and finished
  assert.deepEqual(seen.map((s) => s.phase), ["paused", "paused", "background", "idle"]);
  assert.equal(session.state().phase, "idle");
});

test("pausing twice or resuming when not paused does nothing", () => {
  const session = new ComputerUseSession();
  const seen = record(session);
  session.resume();
  session.pause();
  session.pause();
  assert.equal(seen.length, 1);
  session.resume();
  session.resume();
  assert.deepEqual(seen.map((s) => s.phase), ["paused", "idle"]);
});

test("stop while paused fails the waiting action and clears the pause", async () => {
  const session = new ComputerUseSession();
  session.pause();
  let ran = false;
  const next = session.run({ action: "click" }, async () => ((ran = true), 1));
  await tick();
  session.stop();
  await assert.rejects(next, ComputerUseStoppedError);
  assert.equal(ran, false);
  assert.equal(session.isPaused, false);
  assert.deepEqual(session.state(), { phase: "idle" });
});

test("cancelling the run while paused fails the waiting action", async () => {
  const session = new ComputerUseSession();
  session.pause();
  const outer = new AbortController();
  const next = session.run({ action: "click" }, async () => 1, outer.signal);
  await tick();
  outer.abort();
  await assert.rejects(next, ComputerUseStoppedError);
});

test("a pause nobody resumes expires, so the overlay is not stuck forever", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const session = new ComputerUseSession();
    session.pause();
    assert.equal(session.state().phase, "paused");
    mock.timers.tick(2 * 60_000 + 1);
    assert.equal(session.state().phase, "idle");
  } finally {
    mock.timers.reset();
  }
});

test("a throwing listener cannot break an action", async () => {
  const session = new ComputerUseSession();
  session.onState(() => {
    throw new Error("boom");
  });
  assert.equal(await session.run({ action: "x" }, async () => "fine"), "fine");
});
