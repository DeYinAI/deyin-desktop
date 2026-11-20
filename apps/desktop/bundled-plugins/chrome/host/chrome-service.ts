import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@deyin/agent-core";
import type { ChromeBridgeStatus } from "@deyin/contract";
import { ChromeBridge } from "./chrome-bridge.js";
import { ChromeControl, type OriginApprovalRequest, type OriginDecision } from "./chrome-control.js";
import { DEYIN_EXTENSION_ID } from "./chrome-protocol.js";
import { createChromeTools } from "./chrome-tools.js";

export interface ChromeServiceOptions {
  /** Directory this service owns: identity.json, approved origins, the extension copy. */
  dataDir: string;
  /** Shipped extension sources, or null when this build has none. */
  extensionSource: string | null;
  isEnabled: () => boolean;
  strategy: () => "group" | "window";
  requestOriginApproval: (request: OriginApprovalRequest) => Promise<OriginDecision>;
  saveImage?: (threadId: string, image: { base64: string; mediaType: string }) => string | null;
  /** Relay ports to try; tests pass [0] for an ephemeral port. */
  ports?: readonly number[];
}

/**
 * Copy `src` over `dest` so `dest` ends up identical, touching only files that
 * differ. Returns true when anything changed. The extension folder is what the
 * user points Chrome's "Load unpacked" at, so it must track the shipped
 * sources on every build rather than only when a plugin version is bumped.
 */
export function syncDirectory(src: string, dest: string): boolean {
  let changed = false;
  mkdirSync(dest, { recursive: true });
  const wanted = new Set<string>();
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    wanted.add(entry.name);
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      changed = syncDirectory(from, to) || changed;
      continue;
    }
    const next = readFileSync(from);
    const same = existsSync(to) && readFileSync(to).equals(next);
    if (!same) {
      cpSync(from, to);
      changed = true;
    }
  }
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    if (wanted.has(entry.name)) continue;
    rmSync(join(dest, entry.name), { recursive: true, force: true });
    changed = true;
  }
  return changed;
}

/**
 * Everything the app needs from the Chrome module: the relay, the tab/origin
 * rules, the agent tools, and a status the settings page can render. Free of
 * Electron so it can be exercised against a fake extension in tests.
 */
export class ChromeService {
  readonly bridge: ChromeBridge;
  readonly control: ChromeControl;
  private readonly events = new EventEmitter();
  private readonly extensionDir: string;
  private lastError: string | undefined;
  private extensionReady = false;

  constructor(private readonly opts: ChromeServiceOptions) {
    this.extensionDir = join(opts.dataDir, "extension");
    this.bridge = new ChromeBridge({
      dataDir: opts.dataDir,
      ...(opts.ports ? { ports: opts.ports } : {}),
    });
    this.control = new ChromeControl({
      bridge: this.bridge,
      approvedOriginsFile: join(opts.dataDir, "approved-origins.json"),
      strategy: opts.strategy,
      requestOriginApproval: opts.requestOriginApproval,
      ...(opts.saveImage ? { saveImage: opts.saveImage } : {}),
    });
    const changed = () => this.events.emit("status", this.status());
    this.bridge.on("status", changed);
    this.control.on("tabs", changed);
    this.control.on("activity", (active: boolean) => this.events.emit("active", active));
  }

  /** Start or stop the relay to match the setting. Safe to call repeatedly. */
  async applyEnabled(): Promise<void> {
    if (!this.opts.isEnabled()) {
      await this.bridge.stop();
      this.lastError = undefined;
      this.events.emit("status", this.status());
      return;
    }
    const syncError = this.syncExtension();
    let startError: string | undefined;
    try {
      await this.bridge.start();
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err);
    }
    this.lastError = startError ?? syncError;
    this.events.emit("status", this.status());
  }

  /** Make the user-visible extension folder match the shipped sources; returns an error message on failure. */
  private syncExtension(): string | undefined {
    const source = this.opts.extensionSource;
    if (!source || !existsSync(join(source, "manifest.json"))) {
      this.extensionReady = false;
      return undefined;
    }
    try {
      syncDirectory(source, this.extensionDir);
      this.extensionReady = true;
      return undefined;
    } catch (err) {
      this.extensionReady = false;
      return `Could not prepare the extension folder: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  tools(): ToolDefinition[] {
    return createChromeTools(this.control);
  }

  /** Folder to hand to Chrome's "Load unpacked", or null when this build has no extension. */
  extensionPath(): string | null {
    return this.extensionReady ? this.extensionDir : null;
  }

  status(): ChromeBridgeStatus {
    const snap = this.control.status();
    const error = this.lastError ?? snap.error;
    return {
      enabled: this.opts.isEnabled(),
      listening: snap.listening,
      port: snap.port,
      extensionId: DEYIN_EXTENSION_ID,
      connection: snap.connection,
      pairingCode: snap.pairingCode,
      pairingOpenUntil: snap.pairingOpenUntil,
      stopped: snap.stopped,
      browser: snap.browser,
      pairedBrowsers: snap.paired,
      tabs: snap.tabs.flatMap((tab) => {
        // The extension only reports agent and shared tabs; skip anything else defensively.
        if (!tab.agent && !tab.shared) return [];
        const owner = this.control.ownerOf(tab.id);
        return [{ id: tab.id, title: tab.title, url: tab.url, kind: tab.agent ? ("agent" as const) : ("shared" as const), ...(owner ? { owner } : {}) }];
      }),
      extensionPath: this.extensionPath(),
      ...(error ? { error } : {}),
    };
  }

  onStatus(cb: (status: ChromeBridgeStatus) => void): () => void {
    this.events.on("status", cb);
    return () => this.events.off("status", cb);
  }

  onActive(cb: (active: boolean) => void): () => void {
    this.events.on("active", cb);
    return () => this.events.off("active", cb);
  }

  beginPairing(): ChromeBridgeStatus {
    this.bridge.beginPairing();
    return this.status();
  }

  cancelPairing(): ChromeBridgeStatus {
    this.bridge.cancelPairing();
    return this.status();
  }

  forgetBrowser(browserId: string): ChromeBridgeStatus {
    this.bridge.forget(browserId);
    return this.status();
  }

  async stop(): Promise<ChromeBridgeStatus> {
    await this.control.stop();
    return this.status();
  }

  /**
   * Resume after Stop. If the user stopped from the extension, only the extension
   * popup can undo that, and the refusal is reported rather than hidden.
   */
  async resume(): Promise<ChromeBridgeStatus> {
    try {
      await this.control.resume();
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    const status = this.status();
    this.events.emit("status", status);
    return status;
  }

  async closeAgentTabs(): Promise<ChromeBridgeStatus> {
    await this.control.closeAllAgentTabs();
    return this.status();
  }

  getApprovedOrigins(): string[] {
    return this.control.getApprovedOrigins();
  }

  setApprovedOrigins(origins: string[]): string[] {
    return this.control.setApprovedOrigins(origins);
  }

  async dispose(): Promise<void> {
    await this.bridge.stop();
    this.events.removeAllListeners();
  }
}
