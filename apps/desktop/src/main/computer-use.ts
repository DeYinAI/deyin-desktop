import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { app, globalShortcut } from "electron";
import type { ToolDefinition } from "@deyin/agent-core";
import {
  createComputerUseHost,
  PipeComputerUseHost,
  HostRpcError,
  RPC_CODES,
  resolveHostExe,
  hostLogPath,
  type ComputerUseHostApi,
  type HostEvent,
  type WindowInfo,
} from "@deyin/computer-use-host";
import type { ComputerUseHostStatus, ComputerUseState } from "@deyin/contract";
import { ComputerUseSession } from "../../bundled-plugins/computer-use/host/computer-session.js";
import { createComputerUseTools } from "../../bundled-plugins/computer-use/host/computer-tools.js";

interface AllowlistFile {
  apps: string[];
}

/**
 * Stops computer use from anywhere on the desktop. Esc is not used: it would be swallowed system-wide while an
 * action runs. The chord is registered only while computer use is active.
 */
export const COMPUTER_USE_STOP_ACCELERATOR = "CommandOrControl+Alt+Shift+Escape";

/**
 * Pressing the Stop chord is real keyboard input, which the host reads as the user taking over. Right after a
 * stop, that event must not turn into a "you took over" pause for an action that is already being stopped.
 */
const TAKEOVER_QUIET_AFTER_STOP_MS = 1_500;

/** A window's owning app does not change; a short cache keeps a chain of actions from asking the host each time. */
const WINDOW_CACHE_MS = 3_000;

type AppDecision = "always" | "once" | "deny";

/** OS-level computer use — Windows native host with mock on other platforms. */
export class ComputerUseService {
  private host: ComputerUseHostApi | null = null;
  private unsubscribeHost: (() => void) | null = null;
  private stopChordRegistered = false;
  private takeoverIgnoredUntil = 0;
  private toolList: ToolDefinition[] | null = null;
  private readonly session = new ComputerUseSession();
  private readonly windowCache = new Map<string, { window: WindowInfo; at: number }>();
  private readonly dataDir: string;
  private readonly shotsDir: string;
  private readonly allowlistPath: string;
  private readonly getRetentionDays: () => number;
  private appApprovalResolver: ((req: { appId: string; action: string }) => Promise<AppDecision>) | null = null;

  constructor(
    private readonly isEnabled: () => boolean,
    private readonly isWindows: () => boolean,
    getRetentionDays: () => number = () => 7,
  ) {
    this.getRetentionDays = getRetentionDays;
    this.dataDir = join(app.getPath("userData"), "computer-use");
    this.shotsDir = join(this.dataDir, "shots");
    this.allowlistPath = join(this.dataDir, "allowlist.json");
    mkdirSync(this.shotsDir, { recursive: true });
    if (!existsSync(this.allowlistPath)) {
      writeFileSync(this.allowlistPath, JSON.stringify({ apps: [] } satisfies AllowlistFile, null, 2));
    }
    this.pruneScreenshots();
    this.session.onState((state) => this.syncStopChord(state.phase !== "idle"));
  }

  setAppApprovalResolver(resolver: (req: { appId: string; action: string }) => Promise<AppDecision>): void {
    this.appApprovalResolver = resolver;
  }

  /* State, Stop and Resume ------------------------------------------------------- */

  getState(): ComputerUseState {
    return this.session.state();
  }

  /** Live phase of the running action, for the overlay windows and the in-app banner. */
  onState(cb: (state: ComputerUseState) => void): () => void {
    return this.session.onState(cb);
  }

  /** Stop whatever is running, now. Safe when idle. */
  stop(): void {
    this.takeoverIgnoredUntil = Date.now() + TAKEOVER_QUIET_AFTER_STOP_MS;
    this.session.stop();
    void this.host?.cancel?.().catch(() => undefined);
  }

  /** Continue after the user took over. */
  resume(): void {
    this.session.resume();
  }

  dispose(): void {
    this.stop();
    this.syncStopChord(false);
    this.unsubscribeHost?.();
    this.unsubscribeHost = null;
    this.host?.dispose?.();
    this.host = null;
  }

  private syncStopChord(active: boolean): void {
    if (active === this.stopChordRegistered) return;
    try {
      if (active) {
        this.stopChordRegistered = globalShortcut.register(COMPUTER_USE_STOP_ACCELERATOR, () => this.stop());
      } else {
        globalShortcut.unregister(COMPUTER_USE_STOP_ACCELERATOR);
        this.stopChordRegistered = false;
      }
    } catch {
      // headless, or the chord belongs to another app; the Stop button still works
      this.stopChordRegistered = false;
    }
  }

  private onHostEvent(event: HostEvent): void {
    if (event.type === "takeover") {
      if (Date.now() >= this.takeoverIgnoredUntil) this.session.pause();
      return;
    }
    if (event.type === "input") {
      const data = (event.data ?? {}) as { active?: unknown; x?: unknown; y?: unknown };
      const point =
        typeof data.x === "number" && typeof data.y === "number" ? { x: data.x, y: data.y } : undefined;
      this.session.setRawInput(data.active === true, point);
    }
  }

  /* Host -------------------------------------------------------------------------- */

  private ensureHost(): ComputerUseHostApi {
    if (!this.isEnabled()) throw new Error("Computer use is disabled. Enable it in Settings → Computer Use.");
    if (!this.isWindows()) throw new Error("Computer use is available on Windows only.");
    if (!this.host) {
      this.host = createComputerUseHost({
        shotsDir: this.shotsDir,
        resourcesPath: process.resourcesPath,
        logPath: hostLogPath(this.dataDir),
      });
      this.unsubscribeHost = this.host.onEvent?.((event) => this.onHostEvent(event)) ?? null;
    }
    return this.host;
  }

  /** The host, with this action's cancellation attached (Stop, the Stop chord, or the run being cancelled). */
  private hostFor(signal?: AbortSignal): ComputerUseHostApi {
    const host = this.ensureHost();
    if (host instanceof PipeComputerUseHost) host.setAbortSignal(signal);
    return host;
  }

  getHostPath(): string {
    return resolveHostExe(process.resourcesPath);
  }

  async listAppsPreview(): Promise<unknown> {
    return this.ensureHost().listApps();
  }

  async getHostStatus(): Promise<ComputerUseHostStatus> {
    if (!this.isWindows()) {
      return { ok: false, error: "Computer use is available on Windows only.", hostExists: false };
    }
    if (!this.isEnabled()) {
      return { ok: false, error: "Computer use is disabled. Enable it in Settings → Computer Use.", hostExists: false };
    }
    const hostPath = this.getHostPath();
    if (!existsSync(hostPath)) {
      return {
        ok: false,
        error: "Computer use host executable not found. Reinstall Deyin or rebuild the sidecar.",
        hostPath,
        hostExists: false,
      };
    }
    try {
      const ok = await this.ensureHost().ping();
      if (ok) return { ok: true, hostPath, hostExists: true };
      return {
        ok: false,
        error: "Computer use host did not respond. Install .NET 8 Desktop Runtime or restart Deyin.",
        hostPath,
        hostExists: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, hostPath, hostExists: true };
    }
  }

  /* Permissions ------------------------------------------------------------------- */

  getAllowlist(): string[] {
    try {
      const parsed = JSON.parse(readFileSync(this.allowlistPath, "utf8")) as AllowlistFile;
      return parsed.apps ?? [];
    } catch {
      return [];
    }
  }

  setAllowlist(apps: string[]): void {
    writeFileSync(this.allowlistPath, JSON.stringify({ apps } satisfies AllowlistFile, null, 2));
  }

  isAppAllowed(appId: string): boolean {
    const list = this.getAllowlist();
    if (list.length === 0) return false;
    return list.some((entry) => entry.toLowerCase() === appId.toLowerCase());
  }

  private async lookupWindow(windowId: string): Promise<WindowInfo> {
    const cached = this.windowCache.get(windowId);
    if (cached && Date.now() - cached.at < WINDOW_CACHE_MS) return cached.window;
    let window: WindowInfo;
    try {
      window = await this.ensureHost().getWindow(windowId);
    } catch (err) {
      if (err instanceof HostRpcError && err.code === RPC_CODES.notFound) {
        throw new Error(`Window "${windowId}" was not found or has been closed; cannot verify permission. Call computer_list_windows.`, {
          cause: err,
        });
      }
      throw err;
    }
    this.windowCache.set(windowId, { window, at: Date.now() });
    return window;
  }

  /** Throws unless the app that owns this window is allowed; asks the user when it is not on the list. */
  private async authorizeWindow(windowId: string): Promise<WindowInfo> {
    const window = await this.lookupWindow(windowId);
    if (!window.app) {
      throw new Error(`Could not tell which app owns window "${windowId}", so it cannot be driven.`);
    }
    await this.ensureAppAllowed(window.app, "interact");
    return window;
  }

  private async ensureAppAllowed(appId: string, action: string): Promise<void> {
    if (this.isAppAllowed(appId)) return;
    if (!this.appApprovalResolver) {
      throw new Error(
        `App "${appId}" is not on the always-allow list and no approval prompt is available. Add it in Settings → Computer Use.`,
      );
    }
    let decision: AppDecision;
    try {
      decision = await this.appApprovalResolver({ appId, action });
    } catch {
      throw new Error(`App "${appId}" approval request failed. Try again or add it in Settings → Computer Use.`);
    }
    if (decision === "deny") throw new Error(`App "${appId}" was denied for computer use.`);
    if (decision === "always") this.setAllowlist([...this.getAllowlist(), appId]);
  }

  /* Housekeeping ------------------------------------------------------------------- */

  pruneScreenshots(): void {
    const days = this.getRetentionDays();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const file of readdirSync(this.shotsDir)) {
      const full = join(this.shotsDir, file);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch {
        // ignore
      }
    }
  }

  tools(): ToolDefinition[] {
    this.toolList ??= createComputerUseTools({
      session: this.session,
      host: (signal) => this.hostFor(signal),
      authorizeWindow: (windowId) => this.authorizeWindow(windowId),
      authorizeApp: (appId, action) => this.ensureAppAllowed(appId, action),
    });
    return this.toolList;
  }
}
