import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import { colors } from "@deyin/branding";

/** Create the main application window: frameless with a custom title bar. */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: colors.bg,
    title: "Deyin",
    // The renderer draws its own top bar with window controls.
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // The workspace Browser tab renders remote pages in an isolated <webview>.
      webviewTag: true,
    },
  });

  window.once("ready-to-show", () => window.show());

  // Open external links in the system browser, never in-app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    window.loadURL(devUrl);
  } else {
    window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }

  return window;
}
