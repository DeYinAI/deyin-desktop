import { app, nativeImage } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Candidate icon paths: packaged extraResources first, then build/ for dev. */
function iconCandidates(): string[] {
  const desktopRoot = join(import.meta.dirname, "../..");
  if (app.isPackaged) {
    return [
      join(process.resourcesPath, "icon.png"),
      process.platform === "win32" ? join(process.resourcesPath, "icon.ico") : "",
      process.platform === "darwin" ? join(process.resourcesPath, "icon.icns") : "",
    ].filter(Boolean);
  }
  return [
    join(desktopRoot, "build/icon.png"),
    join(desktopRoot, "build/icon.ico"),
    join(desktopRoot, "build/icon.icns"),
  ];
}

/** Absolute path to the app icon raster, or null if icons were not generated yet. */
export function resolveAppIconPath(): string | null {
  for (const path of iconCandidates()) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** Load the Deyin app icon for BrowserWindow / Tray. Empty if build/ icons are missing. */
export function loadAppIcon(): Electron.NativeImage {
  const path = resolveAppIconPath();
  if (!path) return nativeImage.createEmpty();
  const image = nativeImage.createFromPath(path);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}
