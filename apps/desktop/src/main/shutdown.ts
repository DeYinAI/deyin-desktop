import { app } from "electron";
import { logLine } from "./logger.js";
import { disposeTray } from "./tray.js";
import type { IpcServices } from "./ipc.js";

/** True once a full app quit has been requested (not hide-to-tray). */
let quitting = false;
/** True once async cleanup finished and a second app.quit() may proceed. */
let cleanupDone = false;
let cleanupInFlight: Promise<void> | null = null;

export function isAppQuitting(): boolean {
  return quitting;
}

export function logShutdown(event: string, extra?: Record<string, unknown>): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  const message = `[shutdown] ${event}${suffix}`;
  console.log(message);
  logLine("info", message);
}

/** Request a full quit with logging (tray menu, programmatic exit). */
export function requestQuit(reason: string): void {
  logShutdown("request-quit", { reason });
  quitting = true;
  app.quit();
}

async function runCleanup(services: IpcServices | undefined, reason: string): Promise<void> {
  logShutdown("cleanup-start", { reason });
  disposeTray();
  try {
    services?.terminals.disposeAll();
    if (services) await services.shutdown();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logShutdown("cleanup-error", { error: message });
  }
  logShutdown("cleanup-done", { reason });
}

/**
 * Wire Electron quit lifecycle: async cleanup on before-quit, lock release and
 * a Windows force-exit fallback on will-quit.
 */
export function registerAppShutdownHandlers(getServices: () => IpcServices | undefined): void {
  app.on("before-quit", (event) => {
    logShutdown("before-quit", { cleanupDone, quitting });
    if (cleanupDone) return;
    event.preventDefault();
    quitting = true;
    if (cleanupInFlight) return;
    cleanupInFlight = runCleanup(getServices(), "before-quit").finally(() => {
      cleanupDone = true;
      cleanupInFlight = null;
      app.quit();
    });
  });

  app.on("will-quit", () => {
    logShutdown("will-quit");
    try {
      app.releaseSingleInstanceLock();
      logShutdown("single-instance-lock-released");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logShutdown("release-lock-error", { error: message });
    }

    // On Windows, lingering PTY/MCP handles can prevent exit; force after a short grace period.
    if (process.platform === "win32") {
      const timer = setTimeout(() => {
        logShutdown("force-exit", { reason: "shutdown-timeout" });
        app.exit(0);
      }, 5_000);
      timer.unref?.();
    }
  });

  process.on("exit", (code) => {
    logShutdown("process-exit", { code });
  });
}
