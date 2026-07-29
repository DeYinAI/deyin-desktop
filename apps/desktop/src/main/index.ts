import { app, BrowserWindow } from "electron";
import { AuthManager } from "./auth.js";
import { registerIpc, type IpcServices } from "./ipc.js";
import { CH } from "../shared/ipc.js";
import { resolveDeyinConfig } from "../shared/config.js";
import { DEEP_LINK_SCHEME } from "../shared/config.js";
import { initLogger } from "./logger.js";
import { createMainWindow } from "./window.js";
import { disposeTray, ensureTray } from "./tray.js";

let services: IpcServices | undefined;
let workspaceRoot: string | null = null;
let auth: AuthManager | undefined;

/**
 * Register deyin:// as this app's protocol handler. Returns false when it is
 * unavailable (unpackaged `electron-vite dev` has no stable executable to
 * register), so auth falls back to the loopback flow.
 */
function registerDeepLinkScheme(): boolean {
  if (!app.isPackaged) return false;
  try {
    return app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  } catch {
    return false;
  }
}

/** Pull a deyin:// URL out of a process argv list (Windows/Linux delivery). */
function deepLinkFromArgv(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`));
}

function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

async function handleDeepLink(url: string | undefined): Promise<void> {
  if (!url || !auth) return;
  await auth.completeDeepLink(url);
  focusMainWindow();
}

async function bootstrap(): Promise<void> {
  // First: every subsequent console.* line (auth, updater, agent) also persists
  // to <logs>/deyin.log, which the diagnostics upload reads.
  initLogger(app.getPath("logs"));

  const config = resolveDeyinConfig();
  const deepLinkAvailable = registerDeepLinkScheme();
  auth = new AuthManager(config, deepLinkAvailable);

  // Push a bootstrap payload to the renderer so it re-reads the session after
  // a browser deep-link login without a manual refresh. Server caches (account
  // plan, model list) are tied to the session, so they drop with it.
  auth.setOnChange(() => {
    services?.notifyAuthChanged();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.authChanged);
    }
  });

  services = registerIpc({
    config,
    auth,
    getWorkspaceRoot: () => workspaceRoot,
    setWorkspaceRoot: (root) => {
      workspaceRoot = root;
    },
  });

  createMainWindow();

  // macOS delivers the deep link via the open-url event.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    void handleDeepLink(url);
  });

  // The app may have been launched cold by the deep link (Windows/Linux).
  void handleDeepLink(deepLinkFromArgv(process.argv));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

// Single-instance: a second launch (e.g. the OS opening the deyin:// link)
// forwards its argv to the running instance instead of starting a new one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    focusMainWindow();
    void handleDeepLink(deepLinkFromArgv(argv));
  });

  app.whenReady().then(bootstrap);
}

app.on("window-all-closed", () => {
  services?.terminals.disposeAll();
  if (process.platform !== "darwin") {
    if (services?.shouldKeepRunningInBackground()) {
      ensureTray(() => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
        else focusMainWindow();
      });
      return;
    }
    app.quit();
  }
});

app.on("before-quit", () => {
  disposeTray();
  services?.terminals.disposeAll();
  services?.dispose();
});
