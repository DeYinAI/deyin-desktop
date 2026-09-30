import { app, BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import { CH } from "@deyin/contract";
import { logLine } from "./logger.js";
import { createUpdateController as createController, type UpdateController } from "./update-controller.js";

export type { UpdateController } from "./update-controller.js";

/**
 * Electron wiring for the in-app updater. All update logic lives in
 * update-controller.ts, which takes these Electron touchpoints as injected
 * dependencies so it can be tested without a running app.
 */
export function createUpdateController(opts: {
  /** Read once at update-available time: download automatically only when on. */
  isAutoUpdateEnabled: () => boolean;
}): UpdateController {
  return createController({
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    getAutoUpdater: () => electronUpdater.autoUpdater,
    broadcast: (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(CH.updatesState, state);
      }
    },
    isAutoUpdateEnabled: opts.isAutoUpdateEnabled,
    log: (message) => logLine("info", `[updater] ${message}`),
  });
}
