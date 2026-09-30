import assert from "node:assert/strict";
import test from "node:test";
import type { UpdateStatus, UpdatesState } from "@deyin/contract";
import {
  INSTALL_HANDOFF_DELAY_MS,
  INSTALL_STALLED_MESSAGE,
  INSTALL_STALL_TIMEOUT_MS,
  createInstallFlow,
} from "../src/main/update-install.js";
import { FakeClock } from "./helpers/fake-clock.js";

function setup(initial: Partial<UpdatesState> = {}, opts: { handOffThrows?: Error } = {}) {
  let state: UpdatesState = {
    status: "downloaded",
    currentVersion: "1.0.29",
    availableVersion: "1.0.30",
    progressPercent: 100,
    ...initial,
  };
  const clock = new FakeClock();
  const logs: string[] = [];
  let handOffs = 0;
  const flow = createInstallFlow({
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
    },
    handOff: () => {
      handOffs++;
      if (opts.handOffThrows) throw opts.handOffThrows;
    },
    log: (message) => logs.push(message),
    timers: { set: clock.set, clear: clock.clear },
  });
  return {
    flow,
    clock,
    logs,
    get state() {
      return state;
    },
    set status(next: UpdateStatus) {
      state = { ...state, status: next };
    },
    get handOffs() {
      return handOffs;
    },
  };
}

test("begin() shows 'installing' immediately but waits before handing off", () => {
  const t = setup();
  assert.equal(t.flow.begin(), true);
  assert.equal(t.state.status, "installing");
  assert.equal(t.handOffs, 0, "the overlay needs a moment to paint before the app quits");

  t.clock.advance(INSTALL_HANDOFF_DELAY_MS - 1);
  assert.equal(t.handOffs, 0);
  t.clock.advance(1);
  assert.equal(t.handOffs, 1);
  assert.equal(t.state.status, "installing", "stays installing until the process is replaced");
});

test("begin() does nothing unless an update is downloaded", () => {
  // Record<UpdateStatus, ...> makes a newly added status fail to compile here until it is considered.
  const others: Record<Exclude<UpdateStatus, "downloaded">, true> = {
    idle: true,
    checking: true,
    available: true,
    "not-available": true,
    downloading: true,
    installing: true,
    error: true,
    unsupported: true,
  };
  for (const status of Object.keys(others) as Array<keyof typeof others>) {
    const t = setup({ status });
    assert.equal(t.flow.begin(), false, `status ${status}`);
    assert.equal(t.state.status, status, `status ${status} must be left alone`);
    assert.equal(t.clock.pendingCount, 0, `status ${status} must not schedule a hand-off`);
    t.clock.advance(INSTALL_STALL_TIMEOUT_MS * 2);
    assert.equal(t.handOffs, 0, `status ${status}`);
  }
});

test("a double click hands off exactly once", () => {
  const t = setup();
  assert.equal(t.flow.begin(), true);
  assert.equal(t.flow.begin(), false);
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS);
  assert.equal(t.handOffs, 1);
});

test("a hand-off that throws becomes an error and is not retried", () => {
  const t = setup({}, { handOffThrows: new Error("spawn EACCES") });
  t.flow.begin();
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS);
  assert.equal(t.state.status, "error");
  assert.equal(t.state.error, "spawn EACCES");
  assert.equal(t.clock.pendingCount, 0, "no watchdog left armed after a failure");
  t.clock.advance(INSTALL_STALL_TIMEOUT_MS * 2);
  assert.equal(t.handOffs, 1);
  assert.equal(t.state.error, "spawn EACCES");
});

test("an updater error during the pause aborts the hand-off", () => {
  const t = setup();
  t.flow.begin();
  assert.equal(t.flow.handleError(new Error("boom")), true);
  assert.equal(t.state.status, "error");
  assert.equal(t.state.error, "boom");
  assert.equal(t.clock.pendingCount, 0);
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS * 2);
  assert.equal(t.handOffs, 0, "never launch an installer after the install already failed");
});

test("handleError() ignores errors that are not about an install in progress", () => {
  for (const status of ["downloaded", "checking", "downloading", "idle"] as const) {
    const t = setup({ status });
    assert.equal(t.flow.handleError(new Error("network")), false, status);
    assert.equal(t.state.status, status, status);
    assert.equal(t.state.error, undefined, status);
  }
});

test("still running long after the hand-off is reported instead of hanging on 'installing'", () => {
  const t = setup();
  t.flow.begin();
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS);
  assert.equal(t.handOffs, 1);

  t.clock.advance(INSTALL_STALL_TIMEOUT_MS - 1);
  assert.equal(t.state.status, "installing");
  t.clock.advance(1);
  assert.equal(t.state.status, "error");
  assert.equal(t.state.error, INSTALL_STALLED_MESSAGE);
});

test("the stall watchdog leaves the state alone if something else already changed it", () => {
  const t = setup();
  t.flow.begin();
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS);
  t.status = "downloaded";
  t.clock.advance(INSTALL_STALL_TIMEOUT_MS);
  assert.equal(t.state.status, "downloaded");
  assert.equal(t.state.error, undefined);
});

test("an error after the hand-off cancels the watchdog and surfaces the real message", () => {
  const t = setup();
  t.flow.begin();
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS);
  assert.equal(t.flow.handleError(new Error("installer exited with code 2")), true);
  assert.equal(t.state.status, "error");
  assert.equal(t.state.error, "installer exited with code 2");
  assert.equal(t.clock.pendingCount, 0);
});

test("the hand-off is skipped if the state left 'installing' during the pause", () => {
  const t = setup();
  t.flow.begin();
  t.status = "error";
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS);
  assert.equal(t.handOffs, 0);
});

test("after an aborted install a fresh download can be installed again", () => {
  const t = setup();
  t.flow.begin();
  t.flow.handleError(new Error("boom"));
  t.status = "downloaded";
  assert.equal(t.flow.begin(), true);
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS);
  assert.equal(t.handOffs, 1, "the aborted attempt's timers must not double-fire");
});

test("each step is logged so a failed update can be diagnosed from the app log", () => {
  const t = setup();
  t.flow.begin();
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS);
  assert.deepEqual(t.logs, ["install: starting (version 1.0.30)", "install: handing off to the installer"]);
});

test("the default timers cancel cleanly (no hand-off, no leaked timer)", () => {
  let state: UpdatesState = { status: "downloaded", currentVersion: "1.0.29", availableVersion: "1.0.30" };
  let handOffs = 0;
  const flow = createInstallFlow({
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
    },
    handOff: () => {
      handOffs++;
    },
    log: () => undefined,
  });
  assert.equal(flow.begin(), true);
  assert.equal(flow.handleError(new Error("cancelled")), true);
  assert.equal(handOffs, 0);
  assert.equal(state.status, "error");
});
