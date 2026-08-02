import { Menu, Tray, app, nativeImage } from "electron";
import { join } from "node:path";

let tray: Tray | null = null;
let pendingReviewCount = 0;
let onShowHandler: (() => void) | null = null;

function buildTrayMenu(): Menu {
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (pendingReviewCount > 0) {
    items.push({
      label: `${pendingReviewCount} change${pendingReviewCount === 1 ? "" : "s"} awaiting review`,
      enabled: false,
    });
    items.push({ type: "separator" });
  }
  items.push({ label: "Show Deyin", click: () => onShowHandler?.() });
  items.push({ type: "separator" });
  items.push({ label: "Quit", click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

function refreshTray(): void {
  if (!tray) return;
  const base = "Deyin";
  tray.setToolTip(pendingReviewCount > 0 ? `${base} — ${pendingReviewCount} pending review` : base);
  tray.setContextMenu(buildTrayMenu());
}

/** Update tray tooltip/menu when file changes await review. */
export function setTrayPendingReviewCount(count: number): void {
  pendingReviewCount = Math.max(0, count);
  refreshTray();
}

export function ensureTray(onShow: () => void): Tray {
  if (tray) return tray;
  onShowHandler = onShow;
  const icon = nativeImage.createFromPath(join(app.getAppPath(), "resources/icon.png"));
  if (icon.isEmpty()) {
    console.warn("[tray] resources/icon.png missing or empty — tray entry will be invisible");
  }
  // On Windows/Linux an empty image renders as a blank/missing tray entry that
  // users can't click to bring the window back. Only fall back to an empty image
  // if no icon shipped; otherwise the loaded icon is used as-is.
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  refreshTray();
  tray.on("click", onShow);
  return tray;
}

export function disposeTray(): void {
  tray?.destroy();
  tray = null;
  onShowHandler = null;
  pendingReviewCount = 0;
}
