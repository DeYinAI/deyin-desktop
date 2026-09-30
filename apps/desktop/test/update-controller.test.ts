import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
import type { AppUpdater } from "electron-updater";
import type { UpdatesState } from "@deyin/contract";
import { createUpdateController } from "../src/main/update-controller.js";
import { INSTALL_HANDOFF_DELAY_MS, INSTALL_STALLED_MESSAGE, INSTALL_STALL_TIMEOUT_MS } from "../src/main/update-install.js";
import { FakeClock } from "./helpers/fake-clock.js";

/** The slice of electron-updater's AppUpdater the controller uses. */
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checks = 0;
  downloads = 0;
  quitAndInstalls: Array<[boolean | undefined, boolean | undefined]> = [];

  checkForUpdates = async (): Promise<null> => {
    this.checks++;
    return null;
  };
  downloadUpdate = async (): Promise<string[]> => {
    this.downloads++;
    return [];
  };
  quitAndInstall = (isSilent?: boolean, isForceRunAfter?: boolean): void => {
    this.quitAndInstalls.push([isSilent, isForceRunAfter]);
  };
}

function setup(opts: { isPackaged?: boolean; autoUpdate?: boolean } = {}) {
  const updater = new FakeUpdater();
  const clock = new FakeClock();
  const broadcasts: UpdatesState[] = [];
  const controller = createUpdateController({
    isPackaged: opts.isPackaged ?? true,
    currentVersion: "1.0.29",
    getAutoUpdater: () => {
      if (opts.isPackaged === false) throw new Error("unpackaged builds must not touch electron-updater");
      return updater as unknown as AppUpdater;
    },
    broadcast: (state) => broadcasts.push(state),
    isAutoUpdateEnabled: () => opts.autoUpdate ?? false,
    log: () => undefined,
    timers: { set: clock.set, clear: clock.clear },
  });
  return { updater, clock, broadcasts, controller };
}

/** Quiet the controller's console.error for tests that emit updater errors on purpose. */
function silenceConsoleError(): void {
  mock.method(console, "error", () => undefined);
}

/** Drive the fake updater to "an update is downloaded and ready". */
function downloadedUpdate(t: ReturnType<typeof setup>): void {
  t.updater.emit("update-available", { version: "1.0.30" });
  t.updater.emit("update-downloaded", { version: "1.0.30" });
  assert.equal(t.controller.getState().status, "downloaded");
}

test("install hands off to a NON-silent installer that relaunches the app", () => {
  const t = setup();
  downloadedUpdate(t);
  t.controller.install();
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS);
  // (isSilent=false, isForceRunAfter=true). Silent (true, …) is what made updates invisible.
  assert.deepEqual(t.updater.quitAndInstalls, [[false, true]]);
});

test("install publishes 'installing' to the windows before the app quits", () => {
  const t = setup();
  downloadedUpdate(t);
  const before = t.broadcasts.length;
  t.controller.install();

  assert.equal(t.controller.getState().status, "installing");
  assert.equal(t.broadcasts.length, before + 1);
  assert.equal(t.broadcasts.at(-1)?.status, "installing");
  assert.equal(t.broadcasts.at(-1)?.availableVersion, "1.0.30", "the overlay names the version");
  assert.deepEqual(t.updater.quitAndInstalls, [], "the app must not quit before the screen is shown");
});

test("install is ignored unless an update has been downloaded", () => {
  const t = setup();
  const before = t.broadcasts.length;
  t.controller.install(); // idle
  t.updater.emit("update-available", { version: "1.0.30" });
  t.controller.install(); // available, not yet downloaded
  t.clock.advance(INSTALL_STALL_TIMEOUT_MS);
  assert.deepEqual(t.updater.quitAndInstalls, []);
  assert.equal(t.controller.getState().status, "available");
  assert.equal(t.broadcasts.length, before + 1, "only the update-available broadcast");
});

test("background updater events cannot knock the app out of 'installing'", () => {
  const t = setup({ autoUpdate: true });
  downloadedUpdate(t);
  const downloadsBefore = t.updater.downloads;
  t.controller.install();
  const broadcastsDuringInstall = t.broadcasts.length;

  t.updater.emit("checking-for-update");
  t.updater.emit("update-available", { version: "1.0.30" });
  t.updater.emit("download-progress", { percent: 12.4 });
  t.updater.emit("update-downloaded", { version: "1.0.30" });
  t.updater.emit("update-not-available");

  assert.equal(t.controller.getState().status, "installing");
  assert.equal(t.broadcasts.length, broadcastsDuringInstall, "no state churn while installing");
  assert.equal(t.updater.downloads, downloadsBefore, "no new download may start mid-install");
});

test("update checks are ignored while installing", async () => {
  const t = setup();
  downloadedUpdate(t);
  t.controller.install();
  const checksBefore = t.updater.checks;

  assert.equal((await t.controller.check({ userInitiated: true })).status, "installing");
  assert.equal((await t.controller.checkThrottled(0)).status, "installing");
  assert.equal(t.updater.checks, checksBefore);
});

test("a failure during hand-off is shown, not swallowed as 'up to date'", () => {
  silenceConsoleError();
  const t = setup();
  downloadedUpdate(t);
  t.controller.install();
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS);
  t.updater.emit("error", new Error("spawn EACCES"));

  assert.equal(t.controller.getState().status, "error");
  assert.equal(t.controller.getState().error, "spawn EACCES");
  assert.equal(t.controller.getState().availableVersion, "1.0.30", "the banner still names the update");
  mock.restoreAll();
});

test("a process that never exits after the hand-off ends up as an error, not an endless overlay", () => {
  const t = setup();
  downloadedUpdate(t);
  t.controller.install();
  t.clock.advance(INSTALL_HANDOFF_DELAY_MS + INSTALL_STALL_TIMEOUT_MS);
  assert.equal(t.controller.getState().status, "error");
  assert.equal(t.controller.getState().error, INSTALL_STALLED_MESSAGE);
});

test("unpackaged builds report 'unsupported' and never touch electron-updater", async () => {
  const t = setup({ isPackaged: false });
  assert.equal(t.controller.getState().status, "unsupported");
  assert.equal(t.broadcasts.at(-1)?.status, "unsupported");
  assert.equal((await t.controller.check()).status, "unsupported");
  assert.equal((await t.controller.download()).status, "unsupported");
  t.controller.install();
  assert.deepEqual(t.updater.quitAndInstalls, []);
});

test("packaged builds disable auto-download and enable install-on-quit", () => {
  const t = setup();
  assert.equal(t.updater.autoDownload, false);
  assert.equal(t.updater.autoInstallOnAppQuit, true);
});

test("update-available downloads automatically only when auto-update is on", () => {
  const on = setup({ autoUpdate: true });
  on.updater.emit("update-available", { version: "1.0.30" });
  assert.equal(on.updater.downloads, 1);

  const off = setup({ autoUpdate: false });
  off.updater.emit("update-available", { version: "1.0.30" });
  assert.equal(off.updater.downloads, 0);
  assert.equal(off.controller.getState().status, "available");
});

test("download progress is rounded into the state", () => {
  const t = setup();
  t.updater.emit("update-available", { version: "1.0.30" });
  t.updater.emit("download-progress", { percent: 41.6 });
  assert.equal(t.controller.getState().status, "downloading");
  assert.equal(t.controller.getState().progressPercent, 42);
});

test("updater errors keep their original meaning outside an install", async () => {
  silenceConsoleError();

  // Background poll failure: stay quiet.
  const background = setup();
  await background.controller.checkThrottled(0);
  background.updater.emit("error", new Error("404"));
  assert.equal(background.controller.getState().status, "not-available");
  assert.equal(background.controller.getState().error, undefined);

  // User-initiated check failure: show it.
  const manual = setup();
  await manual.controller.check({ userInitiated: true });
  manual.updater.emit("error", new Error("offline"));
  assert.equal(manual.controller.getState().status, "error");
  assert.equal(manual.controller.getState().error, "offline");

  // Failure while downloading: show it, keep the version.
  const download = setup();
  download.updater.emit("update-available", { version: "1.0.30" });
  download.updater.emit("download-progress", { percent: 10 });
  download.updater.emit("error", new Error("connection reset"));
  assert.equal(download.controller.getState().status, "error");
  assert.equal(download.controller.getState().availableVersion, "1.0.30");
  mock.restoreAll();
});
