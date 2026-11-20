import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, app, session, webContents, type WebContents } from "electron";
import type { ToolDefinition } from "@deyin/agent-core";
import { CH } from "@deyin/contract";
import type { BrowserTabCommand } from "@deyin/contract";
import { createBrowserTools, type BrowserToolHost, type TabAction } from "./browser-tools.js";
import { CdpPage } from "./cdp-page.js";
import { ElectronDebuggerTransport } from "./electron-transport.js";

/**
 * Real browser control (Cursor-style): the agent drives the workspace panel's
 * <webview> tabs through main-process tools. Each tab is driven by the shared
 * CdpPage (the same driver the user's Chrome uses): an accessibility-tree
 * snapshot with stable refs and trusted input events. Console and network
 * activity are captured per tab; screenshots go to files. The webview uses a
 * per-workspace persistent session partition, so logins survive restarts and
 * stay isolated between workspaces.
 */

const MAX_TABS = 8;
/** How long navigate waits for a page to finish loading before handing control back. */
const NAVIGATION_SETTLE_MS = 12_000;

export function workspacePartition(root: string | null): string {
  const hash = createHash("sha256").update(root ?? "default").digest("hex").slice(0, 12);
  return `persist:deyin-ws-${hash}`;
}

interface TabDriver {
  transport: ElectronDebuggerTransport;
  page: CdpPage;
}

export class BrowserControlService implements BrowserToolHost {
  private wcId: number | null = null;
  private tabRegistry = new Map<number, { url: string; title: string }>();
  private activeTabId: number | null = null;
  private attachedIds = new Set<number>();
  private drivers = new Map<number, TabDriver>();
  private activeToolDepth = 0;
  private shotDir: string;

  constructor(
    private readonly getWorkspaceRoot: () => string | null,
    private readonly isEnabled: () => boolean,
    private readonly saveImage?: (threadId: string, image: { base64: string; mediaType: string }) => string | null,
  ) {
    this.shotDir = join(app.getPath("userData"), "browser-shots");
    mkdirSync(this.shotDir, { recursive: true });
  }

  /* Registration ------------------------------------------------------------ */

  /** Register the active controlled tab (legacy single-tab API). */
  register(webContentsId: number | null): void {
    if (webContentsId === null) {
      this.wcId = null;
      return;
    }
    this.setActiveTab(webContentsId);
  }

  /** Sync tab metadata from the renderer (url/title updates). */
  syncTab(webContentsId: number, url: string, title: string): void {
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      this.tabRegistry.delete(webContentsId);
      return;
    }
    this.tabRegistry.set(webContentsId, {
      url: url || wc.getURL(),
      title: title || wc.getTitle() || "New Tab",
    });
    this.ensureAttached(wc);
  }

  /** Remove a tab from the registry when its webview is destroyed. */
  removeTab(webContentsId: number): void {
    this.tabRegistry.delete(webContentsId);
    this.attachedIds.delete(webContentsId);
    this.dropDriver(webContentsId);
    if (this.activeTabId === webContentsId) {
      this.activeTabId = null;
      this.wcId = null;
      const next = [...this.tabRegistry.keys()].at(-1) ?? null;
      if (next !== null) this.setActiveTab(next);
    }
  }

  /** The tab being controlled right now, or null when none is open. Never opens one. */
  activeWebContents(): WebContents | null {
    const wc = this.wcId !== null ? webContents.fromId(this.wcId) : null;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  setActiveTab(webContentsId: number): void {
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    this.wcId = webContentsId;
    this.activeTabId = webContentsId;
    if (!this.tabRegistry.has(webContentsId)) {
      this.tabRegistry.set(webContentsId, { url: wc.getURL(), title: wc.getTitle() || "New Tab" });
    }
    this.ensureAttached(wc);
  }

  private ensureAttached(wc: WebContents): void {
    const id = wc.id;
    if (this.attachedIds.has(id)) return;
    this.attachedIds.add(id);
    this.attachWindowOpenHandler(wc);
    wc.on("did-navigate", () => {
      this.tabRegistry.set(id, { url: wc.getURL(), title: wc.getTitle() || "New Tab" });
    });
    wc.on("page-title-updated", () => {
      this.tabRegistry.set(id, { url: wc.getURL(), title: wc.getTitle() || "New Tab" });
    });
    wc.once("destroyed", () => {
      this.removeTab(id);
    });
    // Start collecting console and network output now, so the first tail after a
    // page load includes the load itself. A busy debugger (DevTools open) is not
    // fatal: the driver is rebuilt on the next tool call.
    void this.driverFor(wc).catch(() => undefined);
  }

  private attachWindowOpenHandler(wc: WebContents): void {
    wc.setWindowOpenHandler(({ url }) => {
      if (url && this.tabRegistry.size < MAX_TABS) {
        void this.openTabInRenderer(url);
      }
      return { action: "deny" };
    });
  }

  /* Page drivers --------------------------------------------------------------- */

  private dropDriver(id: number): void {
    const driver = this.drivers.get(id);
    if (!driver) return;
    this.drivers.delete(id);
    driver.page.dispose();
    driver.transport.dispose();
  }

  /** The tab's page driver, created (and its CDP domains enabled) on first use. */
  private async driverFor(wc: WebContents): Promise<CdpPage> {
    const existing = this.drivers.get(wc.id);
    if (existing && !existing.transport.alive) this.dropDriver(wc.id);
    let driver = this.drivers.get(wc.id);
    if (!driver) {
      const transport = new ElectronDebuggerTransport(wc, () => this.dropDriver(wc.id));
      driver = { transport, page: new CdpPage(transport, { snapshotTool: "browser_snapshot" }) };
      this.drivers.set(wc.id, driver);
    }
    try {
      await driver.page.init();
    } catch (err) {
      this.dropDriver(wc.id);
      throw err;
    }
    return driver.page;
  }

  /* Renderer coordination ----------------------------------------------------- */

  private broadcastTabCommand(cmd: BrowserTabCommand): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.browserTabCommand, cmd);
    }
  }

  private ensureBrowserPanel(): void {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CH.browserEnsure);
  }

  private async openTabInRenderer(url: string): Promise<void> {
    this.ensureBrowserPanel();
    const before = this.tabRegistry.size;
    this.broadcastTabCommand({ action: "open", url: normalizeUrl(url) });
    try {
      await this.waitFor(() => this.tabRegistry.size > before || this.tabRegistry.size >= MAX_TABS, "open tab");
    } catch (err) {
      if (this.activeTabId && this.tabRegistry.has(this.activeTabId)) {
        await this.navigate(url);
        return;
      }
      throw err;
    }
  }

  private async switchTabInRenderer(tabId: number): Promise<void> {
    this.ensureBrowserPanel();
    this.broadcastTabCommand({ action: "switch", tabId });
    await this.waitFor(() => this.activeTabId === tabId, "switch tab");
  }

  private async closeTabInRenderer(tabId: number): Promise<void> {
    this.broadcastTabCommand({ action: "close", tabId });
    await this.waitFor(() => !this.tabRegistry.has(tabId), "close tab");
  }

  private async waitFor(predicate: () => boolean, label: string, attempts = 24): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      if (predicate()) return;
      await sleep(250);
    }
    throw new Error(`Timed out waiting to ${label}. Open the Browser tab in the workspace panel and retry.`);
  }

  private setBrowserActive(active: boolean): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.browserActive, active);
    }
  }

  private async withBrowserTool<T>(fn: () => Promise<T>): Promise<T> {
    this.activeToolDepth += 1;
    if (this.activeToolDepth === 1) this.setBrowserActive(true);
    try {
      return await fn();
    } finally {
      this.activeToolDepth -= 1;
      if (this.activeToolDepth === 0) this.setBrowserActive(false);
    }
  }

  /* Target acquisition -------------------------------------------------------- */

  private async target(): Promise<WebContents> {
    if (!this.isEnabled()) {
      throw new Error("Browser control is disabled. Enable it in Settings → Browser.");
    }
    let wc = this.wcId !== null ? webContents.fromId(this.wcId) : null;
    if (wc && !wc.isDestroyed()) return wc;

    this.ensureBrowserPanel();
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      wc = this.wcId !== null ? webContents.fromId(this.wcId) : null;
      if (wc && !wc.isDestroyed()) return wc;
    }
    throw new Error("No browser tab available. Open the Browser tab in the workspace panel and retry.");
  }

  /* BrowserToolHost ------------------------------------------------------------ */

  withPage<T>(fn: (page: CdpPage) => Promise<T>): Promise<T> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      return fn(await this.driverFor(wc));
    });
  }

  async navigate(url: string): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      // Make sure the page driver is listening before the load starts.
      const page = await this.driverFor(wc).catch(() => null);
      const target = normalizeUrl(url);
      try {
        await wc.loadURL(target);
        // loadURL settles when *a* load finishes, which can be the previous
        // navigation (a fresh tab's about:blank). Wait for this one to finish
        // so the next tool call does not act on a half-loaded page.
        const deadline = Date.now() + NAVIGATION_SETTLE_MS;
        while (wc.isLoading() && Date.now() < deadline) await sleep(100);
        await page?.waitForLoad(Math.max(1000, deadline - Date.now()));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ERR_CONNECTION_REFUSED") || msg.includes("-102")) {
          const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i.test(target);
          if (isLocal) {
            throw new Error(
              `Connection refused at ${target} — ensure the local dev server is running and accepting connections on this port before navigating. (Underlying error: ${msg})`,
            );
          }
        }
        throw err;
      }
      return `Loaded ${wc.getURL()} — "${wc.getTitle()}"`;
    });
  }

  async screenshot(threadId?: string): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      try {
        await wc.executeJavaScript("new Promise((r) => requestAnimationFrame(() => setTimeout(r, 16)))", true);
      } catch {
        // ignore
      }
      const image = await wc.capturePage();
      const uniqueSuffix = randomUUID().slice(0, 8);
      const file = join(this.shotDir, `shot-${Date.now()}-${uniqueSuffix}.png`);
      writeFileSync(file, image.toPNG());
      // Also land the shot in the thread image store: the inline-image
      // directive renders it directly in chat, sparing the agent a doomed
      // binary read through the text read tool.
      let directive = "";
      if (threadId && this.saveImage) {
        try {
          const stored = this.saveImage(threadId, {
            base64: image.toPNG().toString("base64"),
            mediaType: "image/png",
          });
          if (stored) {
            directive =
              `\n::deyin-inline-image{file="${stored}" alt="Browser screenshot"}\n` +
              "Put the directive line above in your reply to embed this screenshot.";
          }
        } catch {
          // Fall back to the file-path message below.
        }
      }
      return `Screenshot saved to ${file}.` + directive;
    });
  }

  async manageTabs(action: TabAction, url?: string, tabId?: number): Promise<string> {
    return this.withBrowserTool(async () => {
      switch (action) {
        case "list": {
          const items = [...this.tabRegistry.entries()].map(([id, meta]) => ({
            id,
            url: meta.url,
            title: meta.title,
            active: id === this.activeTabId,
          }));
          return JSON.stringify(items, null, 2);
        }
        case "open": {
          if (!url) return "ERROR: url is required to open a tab";
          if (this.tabRegistry.size >= MAX_TABS) {
            return `ERROR: maximum of ${MAX_TABS} browser tabs reached. Close a tab first.`;
          }
          await this.openTabInRenderer(url);
          const wc = await this.target();
          return `Opened tab ${wc.id}: ${wc.getURL()} — "${wc.getTitle()}"`;
        }
        case "switch": {
          if (tabId === undefined) return "ERROR: tab_id is required to switch tabs";
          if (!this.tabRegistry.has(tabId)) return `ERROR: tab ${tabId} not found`;
          await this.switchTabInRenderer(tabId);
          const wc = webContents.fromId(tabId);
          if (!wc || wc.isDestroyed()) return `ERROR: tab ${tabId} not found`;
          return `Switched to tab ${tabId}: ${wc.getTitle()}`;
        }
        case "close": {
          const id = tabId ?? this.activeTabId;
          if (id === null || !this.tabRegistry.has(id)) return "ERROR: no tab to close";
          await this.closeTabInRenderer(id);
          return `Closed tab ${id}.`;
        }
        default: {
          const _exhaustive: never = action;
          return `ERROR: invalid tabs action ${String(_exhaustive)}`;
        }
      }
    });
  }

  /** Wipe the per-workspace browsing profile (cookies, storage, cache). */
  async clearProfile(): Promise<void> {
    const partition = workspacePartition(this.getWorkspaceRoot());
    const ses = session.fromPartition(partition);
    await ses.clearCache();
    await ses.clearStorageData();
  }

  /* Agent tools ---------------------------------------------------------------- */

  tools(): ToolDefinition[] {
    return createBrowserTools(this);
  }
}

function normalizeUrl(url: string): string {
  // file://, http(s)://, data:, about: and blob: URLs pass through untouched.
  // Schemeless localhost-style addresses are local dev servers - http, not
  // https (no TLS locally). Anything else that looks like a host gets https.
  if (/^(file|https?|data|about|blob):/i.test(url)) return url;
  if (/^localhost([:/]|$)/i.test(url) || /^127\.0\.0\.1[:/]/.test(url) || /^\[::1\][:/]/.test(url)) {
    return `http://${url}`;
  }
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
