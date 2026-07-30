import { Menu, Tray, app, nativeImage } from "electron";
import { join } from "node:path";

let tray: Tray | null = null;

export function ensureTray(onShow: () => void): Tray {
  if (tray) return tray;
  const icon = nativeImage.createFromPath(join(app.getAppPath(), "resources/icon.png"));
  if (icon.isEmpty()) {
    console.warn("[tray] resources/icon.png missing or empty — tray entry will be invisible");
  }
  // On Windows/Linux an empty image renders as a blank/missing tray entry that
  // users can't click to bring the window back. Only fall back to an empty image
  // if no icon shipped; otherwise the loaded icon is used as-is.
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Deyin");
  const menu = Menu.buildFromTemplate([
    { label: "Show Deyin", click: onShow },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", onShow);
  return tray;
}

export function disposeTray(): void {
  tray?.destroy();
  tray = null;
}
