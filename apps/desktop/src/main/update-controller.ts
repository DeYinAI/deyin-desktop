import type { AppUpdater } from "electron-updater";
import type { UpdatesState } from "@deyin/contract";
import { createInstallFlow, type InstallTimers } from "./update-install.js";

export interface UpdateController {
  getState(): UpdatesState;
  check(opts?: { userInitiated?: boolean }): Promise<UpdatesState>;
  checkThrottled(minIntervalMs?: number): Promise<UpdatesState>;
  download(): Promise<UpdatesState>;
  install(): void;
}

/**
 * Everything the controller needs from Electron, injected so the update logic
 * runs (and is tested) without it. The real wiring lives in updater.ts.
 */
export interface UpdateControllerEnv {
  /** False for dev/unpackaged builds, which have no app-update.yml feed. */
  isPackaged: boolean;
  currentVersion: string;
  /** Lazy so unpackaged builds never touch electron-updater's singleton. */
  getAutoUpdater(): AppUpdater;
  /** Push the new state to every open window. */
  broadcast(state: UpdatesState): void;
  /** Read once at update-available time: download automatically only when on. */
  isAutoUpdateEnabled(): boolean;
  log(message: string): void;
  /** Timer seam for the install hand-off and its stall watchdog. */
  timers?: InstallTimers;
}

/**
 * In-app update controller over electron-updater. The feed is the public
 * DeYinAI/deyin-releases repo baked into app-update.yml at package time (the
 * source repo is private, so clients must poll a public one).
 */
export function createUpdateController(env: UpdateControllerEnv): UpdateController {
  let state: UpdatesState = { status: "idle", currentVersion: env.currentVersion };
  let userInitiatedCheck = false;

  const setState = (patch: Partial<UpdatesState>): UpdatesState => {
    state = { ...state, ...patch };
    env.broadcast(state);
    return state;
  };

  // Dev/unpackaged builds have no app-update.yml feed; report a stable
  // unsupported state instead of letting electron-updater throw ENOENT.
  if (!env.isPackaged) {
    setState({ status: "unsupported" });
    return {
      getState: () => state,
      check: async () => state,
      checkThrottled: async () => state,
      download: async () => state,
      install: () => undefined,
    };
  }

  const autoUpdater = env.getAutoUpdater();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  const installFlow = createInstallFlow({
    getState: () => state,
    setState,
    // Deliberately NOT silent. A silent (/S) NSIS install shows no window at all, so the
    // app vanished and users saw nothing for ~20 s until the new version appeared. The
    // one-click installer's own progress window is that feedback; it also asks before
    // giving up when the running app can't be closed, where /S aborts without a word.
    // Non-silent installs relaunch via autoRunAppAfterInstall (default true), so the
    // force-run flag is only honoured for silent installs and is passed for clarity.
    handOff: () => autoUpdater.quitAndInstall(false, true),
    log: env.log,
    timers: env.timers,
  });

  // While an install is being handed off, background events must not overwrite the
  // "installing" state (that would drop the overlay mid-install); only errors get through.
  autoUpdater.on("checking-for-update", () => {
    if (state.status === "installing") return;
    setState({ status: "checking", error: undefined, progressPercent: undefined });
  });
  autoUpdater.on("update-available", (info) => {
    if (state.status === "installing") return;
    setState({ status: "available", availableVersion: info.version });
    if (env.isAutoUpdateEnabled()) {
      void autoUpdater.downloadUpdate().catch(() => {
        /* surfaced via the error event */
      });
    }
  });
  autoUpdater.on("update-not-available", () => {
    if (state.status === "installing") return;
    setState({ status: "not-available", availableVersion: undefined });
  });
  autoUpdater.on("download-progress", (progress) => {
    if (state.status === "installing") return;
    setState({ status: "downloading", progressPercent: Math.round(progress.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    if (state.status === "installing") return;
    setState({ status: "downloaded", availableVersion: info.version, progressPercent: 100 });
  });
  autoUpdater.on("error", (err) => {
    console.error("[deyin updater]", err);
    // A failure during hand-off used to fall through to the background-poll branch below
    // and be swallowed as "not-available", leaving the user with no sign the install failed.
    if (installFlow.handleError(err)) return;
    const isDownloadError =
      state.status === "downloading" ||
      (state.status === "available" && Boolean(state.availableVersion));
    if (isDownloadError) {
      setState({ status: "error", error: err.message });
    } else if (userInitiatedCheck) {
      setState({ status: "error", error: err.message, availableVersion: undefined });
    } else {
      // Background poll failed (e.g. no published release yet) — stay quiet in the UI.
      setState({ status: "not-available", availableVersion: undefined, error: undefined });
    }
    userInitiatedCheck = false;
  });

  let lastCheckTime = 0;
  let inFlightCheck: Promise<UpdatesState> | null = null;

  const check = async (opts?: { userInitiated?: boolean }): Promise<UpdatesState> => {
    if (state.status === "installing") return state;
    if (inFlightCheck) return inFlightCheck;
    userInitiatedCheck = opts?.userInitiated ?? false;
    lastCheckTime = Date.now();
    inFlightCheck = (async () => {
      try {
        await autoUpdater.checkForUpdates();
      } catch {
        /* surfaced via the error event */
      } finally {
        inFlightCheck = null;
      }
      return state;
    })();
    return inFlightCheck;
  };

  const checkThrottled = async (minIntervalMs = 15 * 60 * 1000): Promise<UpdatesState> => {
    if (inFlightCheck) return inFlightCheck;
    if (Date.now() - lastCheckTime < minIntervalMs) return state;
    return check({ userInitiated: false });
  };

  const download = async (): Promise<UpdatesState> => {
    if (state.status === "available") {
      try {
        await autoUpdater.downloadUpdate();
      } catch {
        /* surfaced via the error event */
      }
    }
    return state;
  };

  return {
    getState: () => state,
    check,
    checkThrottled,
    download,
    install: () => {
      installFlow.begin();
    },
  };
}
