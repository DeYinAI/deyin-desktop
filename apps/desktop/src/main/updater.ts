import { app } from "electron";
import electronUpdater from "electron-updater";

/**
 * Wire electron-updater to Deyin's generic release feed. No-op in dev (unpackaged) so
 * local runs never hit the network for updates.
 */
export function initAutoUpdater(feedUrl: string): void {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = electronUpdater;
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    autoUpdater.autoDownload = true;
    autoUpdater.on("error", (err) => console.error("[deyin updater]", err));
    autoUpdater.on("update-downloaded", (info) =>
      console.log(`[deyin updater] update ${info.version} downloaded; will install on quit.`),
    );
    // The returned promise rejects on network/feed errors (e.g. offline, or the
    // feed host not resolving). The "error" event above already logs it; catch
    // here too so a failed check never becomes an unhandled rejection.
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      /* already surfaced via the error event */
    });
  } catch (err) {
    console.error("[deyin updater] init failed", err);
  }
}
