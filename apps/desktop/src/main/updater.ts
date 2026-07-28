import { app, BrowserWindow } from "electron";
import electronUpdater, { type AppUpdater } from "electron-updater";
import { CH } from "../shared/ipc.js";
import type { UpdatesState } from "../shared/types.js";

export interface UpdateController {
  getState(): UpdatesState;
  check(): Promise<UpdatesState>;
  download(): Promise<UpdatesState>;
  install(): void;
}

/**
 * In-app update controller over electron-updater. The feed is the public
 * DeYinAI/deyin-releases repo baked into app-update.yml at package time (the
 * source repo is private, so clients must poll a public one).
 */
export function createUpdateController(opts: {
  /** Read once at update-available time: download automatically only when on. */
  isAutoUpdateEnabled: () => boolean;
}): UpdateController {
  let state: UpdatesState = { status: "idle", currentVersion: app.getVersion() };

  const setState = (patch: Partial<UpdatesState>): UpdatesState => {
    state = { ...state, ...patch };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.updatesState, state);
    }
    return state;
  };

  // Dev/unpackaged builds have no app-update.yml feed; report a stable
  // unsupported state instead of letting electron-updater throw ENOENT.
  if (!app.isPackaged) {
    setState({ status: "unsupported" });
    return {
      getState: () => state,
      check: async () => state,
      download: async () => state,
      install: () => undefined,
    };
  }

  const autoUpdater: AppUpdater = electronUpdater.autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setState({ status: "checking", error: undefined, progressPercent: undefined });
  });
  autoUpdater.on("update-available", (info) => {
    setState({ status: "available", availableVersion: info.version });
    if (opts.isAutoUpdateEnabled()) {
      void autoUpdater.downloadUpdate().catch(() => {
        /* surfaced via the error event */
      });
    }
  });
  autoUpdater.on("update-not-available", () => {
    setState({ status: "not-available", availableVersion: undefined });
  });
  autoUpdater.on("download-progress", (progress) => {
    setState({ status: "downloading", progressPercent: Math.round(progress.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setState({ status: "downloaded", availableVersion: info.version, progressPercent: 100 });
  });
  autoUpdater.on("error", (err) => {
    console.error("[deyin updater]", err);
    setState({ status: "error", error: err.message });
  });

  const check = async (): Promise<UpdatesState> => {
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      /* surfaced via the error event */
    }
    return state;
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
    download,
    install: () => {
      if (state.status === "downloaded") autoUpdater.quitAndInstall();
    },
  };
}
