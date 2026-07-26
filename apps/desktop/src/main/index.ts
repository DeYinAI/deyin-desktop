import { app, BrowserWindow } from "electron";
import { AuthManager } from "./auth.js";
import { resolveDeyinConfig } from "./config.js";
import { registerIpc } from "./ipc.js";
import type { TerminalManager } from "./host/pty.js";
import { CH } from "../shared/ipc.js";
import { DEEP_LINK_SCHEME } from "../shared/config.js";
import { initAutoUpdater } from "./updater.js";
import { createMainWindow } from "./window.js";

let terminals: TerminalManager | undefined;
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
  const config = resolveDeyinConfig();
  const deepLinkAvailable = registerDeepLinkScheme();
  auth = new AuthManager(config, deepLinkAvailable);

  // Push a bootstrap payload to the renderer so it re-reads the session after
  // a browser deep-link login without a manual refresh.
  auth.setOnChange(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.authChanged);
    }
  });

  terminals = registerIpc({
    config,
    auth,
    getWorkspaceRoot: () => workspaceRoot,
    setWorkspaceRoot: (root) => {
      workspaceRoot = root;
    },
  });

  createMainWindow();
  initAutoUpdater(config.updateFeedUrl);

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
  terminals?.disposeAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => terminals?.disposeAll());
