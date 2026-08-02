import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, app, session, webContents, type WebContents } from "electron";
import type { ToolDefinition } from "@deyin/agent-core";
import { CH } from "../../../src/shared/ipc.js";
import type { BrowserTabCommand } from "../../../src/shared/ipc.js";

/**
 * Real browser control (Cursor-style): the agent drives the workspace panel's
 * <webview> tabs through main-process tools. Console and network activity stream to
 * log files the agent tails selectively; screenshots go to files. The webview
 * uses a per-workspace persistent session partition, so logins survive
 * restarts and stay isolated between workspaces.
 */

const MAX_TABS = 8;

const KEY_MAP: Record<string, { keyCode: string; windowsVirtualKeyCode: number }> = {
  enter: { keyCode: "Enter", windowsVirtualKeyCode: 13 },
  tab: { keyCode: "Tab", windowsVirtualKeyCode: 9 },
  escape: { keyCode: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { keyCode: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { keyCode: "Delete", windowsVirtualKeyCode: 46 },
  arrowup: { keyCode: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { keyCode: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { keyCode: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { keyCode: "ArrowRight", windowsVirtualKeyCode: 39 },
  pageup: { keyCode: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { keyCode: "PageDown", windowsVirtualKeyCode: 34 },
  home: { keyCode: "Home", windowsVirtualKeyCode: 36 },
  end: { keyCode: "End", windowsVirtualKeyCode: 35 },
};

interface PendingDialog {
  dialogType: string;
  message: string;
  defaultText: string;
  respond: (accept: boolean, promptText?: string) => void;
}

interface RunDialogInfo {
  dialogType: "alert" | "confirm" | "prompt";
  messageText: string;
  defaultPromptText: string;
}

export function workspacePartition(root: string | null): string {
  const hash = createHash("sha256").update(root ?? "default").digest("hex").slice(0, 12);
  return `persist:deyin-ws-${hash}`;
}

export class BrowserControlService {
  private wcId: number | null = null;
  private tabRegistry = new Map<number, { url: string; title: string }>();
  private activeTabId: number | null = null;
  private attachedIds = new Set<number>();
  private dialogQueues = new Map<number, PendingDialog[]>();
  private activeToolDepth = 0;
  private logDir: string;
  private shotDir: string;

  constructor(
    private readonly getWorkspaceRoot: () => string | null,
    private readonly isEnabled: () => boolean,
  ) {
    this.logDir = join(app.getPath("userData"), "browser-logs");
    this.shotDir = join(app.getPath("userData"), "browser-shots");
    mkdirSync(this.logDir, { recursive: true });
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
    this.dialogQueues.delete(webContentsId);
    this.attachedIds.delete(webContentsId);
    if (this.activeTabId === webContentsId) {
      this.activeTabId = null;
      this.wcId = null;
      const next = [...this.tabRegistry.keys()].at(-1) ?? null;
      if (next !== null) this.setActiveTab(next);
    }
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
    this.attachLogging(wc);
    this.attachDialogHandlers(wc);
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
  }

  private attachDialogHandlers(wc: WebContents): void {
    (wc as WebContents & { on(event: "-run-dialog", listener: (info: RunDialogInfo, callback: (success: boolean, userInput: string) => void) => void): void }).on(
      "-run-dialog",
      (info: RunDialogInfo, callback: (success: boolean, userInput: string) => void) => {
      const queue = this.dialogQueues.get(wc.id) ?? [];
      queue.push({
        dialogType: info.dialogType,
        message: info.messageText,
        defaultText: info.defaultPromptText ?? "",
        respond: (accept, promptText) => callback(accept, promptText ?? ""),
      });
      this.dialogQueues.set(wc.id, queue);
    });
  }

  private attachWindowOpenHandler(wc: WebContents): void {
    wc.setWindowOpenHandler(({ url }) => {
      if (url && this.tabRegistry.size < MAX_TABS) {
        void this.openTabInRenderer(url);
      }
      return { action: "deny" };
    });
  }

  private consoleLogFile(): string {
    return join(this.logDir, "console.log");
  }

  private networkLogFile(): string {
    return join(this.logDir, "network.log");
  }

  private attachLogging(wc: WebContents): void {
    // Reset logs per first attachment so tails reflect the current page session.
    if (this.attachedIds.size <= 1) {
      writeFileSync(this.consoleLogFile(), "");
      writeFileSync(this.networkLogFile(), "");
    }

    wc.on("console-message", (_event, level, message, line, sourceId) => {
      const levelName = ["debug", "log", "warn", "error"][level] ?? String(level);
      appendLine(this.consoleLogFile(), `[${new Date().toISOString()}] [${levelName}] ${message} (${sourceId}:${line})`);
    });

    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      void wc.debugger.sendCommand("Network.enable");
      wc.debugger.on("message", (_event, method, params) => {
        if (method === "Network.responseReceived") {
          const p = params as { response?: { status?: number; url?: string; mimeType?: string } };
          appendLine(
            this.networkLogFile(),
            `[${new Date().toISOString()}] ${p.response?.status ?? "?"} ${p.response?.url ?? ""} (${p.response?.mimeType ?? ""})`,
          );
        } else if (method === "Network.loadingFailed") {
          const p = params as { errorText?: string; requestId?: string };
          appendLine(this.networkLogFile(), `[${new Date().toISOString()}] FAILED ${p.errorText ?? ""}`);
        }
      });
    } catch {
      // Debugger may already be attached by devtools; console logging still works.
    }
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
    await this.waitFor(() => this.tabRegistry.size > before || this.tabRegistry.size >= MAX_TABS, "open tab");
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

  /* Actions ------------------------------------------------------------------ */

  async navigate(url: string): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      const target = normalizeUrl(url);
      await wc.loadURL(target);
      return `Loaded ${wc.getURL()} — "${wc.getTitle()}"`;
    });
  }

  async click(selector: string): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      return (await wc.executeJavaScript(clickScript(selector), true)) as string;
    });
  }

  async type(text: string, selector?: string): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      if (selector) {
        const focused = (await wc.executeJavaScript(focusScript(selector), true)) as string;
        if (focused.startsWith("ERROR")) return focused;
      }
      wc.focus();
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        await wc.debugger.sendCommand("Input.insertText", { text });
      } catch (err) {
        return `ERROR: could not type: ${err instanceof Error ? err.message : String(err)}`;
      }
      return `Typed ${JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text)}${selector ? ` into ${selector}` : ""}`;
    });
  }

  async press(key: string): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      const mapped = KEY_MAP[key.toLowerCase()];
      if (!mapped) return `ERROR: unsupported key "${key}". Supported: ${Object.keys(KEY_MAP).join(", ")}.`;
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        const base = {
          key: mapped.keyCode,
          code: mapped.keyCode,
          windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
          nativeVirtualKeyCode: mapped.windowsVirtualKeyCode,
        };
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      } catch (err) {
        return `ERROR: could not press: ${err instanceof Error ? err.message : String(err)}`;
      }
      return `Pressed ${key}`;
    });
  }

  async scroll(deltaY: number): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      await wc.executeJavaScript(`window.scrollBy({ top: ${Number(deltaY) || 600}, behavior: "instant" }); "ok"`, true);
      return `Scrolled by ${deltaY}px (now at ${(await wc.executeJavaScript("window.scrollY", true)) as number}px)`;
    });
  }

  async screenshot(): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      const image = await wc.capturePage();
      const file = join(this.shotDir, `shot-${Date.now()}.png`);
      writeFileSync(file, image.toPNG());
      return `Screenshot saved to ${file}. Read that file to view it.`;
    });
  }

  async hover(selector: string): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      return (await wc.executeJavaScript(hoverScript(selector), true)) as string;
    });
  }

  async fill(selector: string, value: string): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      return (await wc.executeJavaScript(fillScript(selector, value), true)) as string;
    });
  }

  async fillForm(fields: Array<{ selector: string; value: string }>): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      return (await wc.executeJavaScript(fillFormScript(fields), true)) as string;
    });
  }

  async drag(fromSelector: string, toSelector: string): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      return (await wc.executeJavaScript(dragScript(fromSelector, toSelector), true)) as string;
    });
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      const queue = this.dialogQueues.get(wc.id);
      if (!queue || queue.length === 0) {
        return "ERROR: no pending JavaScript dialog. Wait for alert/confirm/prompt on the page first.";
      }
      const pending = queue.shift()!;
      const text = promptText ?? pending.defaultText;
      pending.respond(accept, text);
      const verb = accept ? "Accepted" : "Dismissed";
      return `${verb} ${pending.dialogType} dialog: ${JSON.stringify(pending.message)}`;
    });
  }

  async manageTabs(action: "list" | "open" | "switch" | "close", url?: string, tabId?: number): Promise<string> {
    return this.withBrowserTool(async () => {
      if (action === "list") {
        const items = [...this.tabRegistry.entries()].map(([id, meta]) => ({
          id,
          url: meta.url,
          title: meta.title,
          active: id === this.activeTabId,
        }));
        return JSON.stringify(items, null, 2);
      }
      if (action === "open" && url) {
        if (this.tabRegistry.size >= MAX_TABS) {
          return `ERROR: maximum of ${MAX_TABS} browser tabs reached. Close a tab first.`;
        }
        await this.openTabInRenderer(url);
        const wc = await this.target();
        return `Opened tab ${wc.id}: ${wc.getURL()} — "${wc.getTitle()}"`;
      }
      if (action === "switch" && tabId !== undefined) {
        if (!this.tabRegistry.has(tabId)) return `ERROR: tab ${tabId} not found`;
        await this.switchTabInRenderer(tabId);
        const wc = webContents.fromId(tabId);
        if (!wc || wc.isDestroyed()) return `ERROR: tab ${tabId} not found`;
        return `Switched to tab ${tabId}: ${wc.getTitle()}`;
      }
      if (action === "close") {
        const id = tabId ?? this.activeTabId;
        if (id === null || !this.tabRegistry.has(id)) return "ERROR: no tab to close";
        await this.closeTabInRenderer(id);
        return `Closed tab ${id}.`;
      }
      return "ERROR: invalid tabs action";
    });
  }

  async clickRef(ref: string): Promise<string> {
    return this.withBrowserTool(async () => {
      const safeRef = validateBrowserRef(ref);
      const wc = await this.target();
      return (await wc.executeJavaScript(clickRefScript(safeRef), true)) as string;
    });
  }

  async snapshot(): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      const result = (await wc.executeJavaScript(SNAPSHOT_SCRIPT, true)) as string;
      return result.length > 12_000 ? `${result.slice(0, 12_000)}\n… (truncated)` : result;
    });
  }

  async currentUrl(): Promise<string> {
    return this.withBrowserTool(async () => {
      const wc = await this.target();
      return `${wc.getURL()} — "${wc.getTitle()}"`;
    });
  }

  tailConsole(lines: number): string {
    return tailFile(this.consoleLogFile(), lines, "console");
  }

  tailNetwork(lines: number): string {
    return tailFile(this.networkLogFile(), lines, "network");
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
    const wrap = (fn: () => Promise<string>): Promise<string> =>
      fn().catch((err) => `ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return [
      {
        name: "browser_navigate",
        description: "Open a URL in the built-in workspace browser tab.",
        tier: "execute",
        parameters: { type: "object", properties: { url: { type: "string", description: "URL to open." } }, required: ["url"] },
        summarize: (args) => String(args.url ?? ""),
        execute: (args) => wrap(() => this.navigate(String(args.url ?? ""))),
      },
      {
        name: "browser_click",
        description: "Click by CSS selector or element ref from browser_snapshot.",
        tier: "execute",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector." },
            ref: { type: "string", description: "Element ref from snapshot (e.g. e12)." },
          },
        },
        summarize: (args) => String(args.ref ?? args.selector ?? ""),
        execute: (args) =>
          wrap(() =>
            args.ref ? this.clickRef(String(args.ref)) : this.click(String(args.selector ?? "")),
          ),
      },
      {
        name: "browser_type",
        description: "Type text into the focused element (or focus a selector first).",
        tier: "execute",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to type." },
            selector: { type: "string", description: "Optional CSS selector to focus first." },
          },
          required: ["text"],
        },
        summarize: (args) => `type ${String(args.text ?? "").slice(0, 40)}`,
        execute: (args) => wrap(() => this.type(String(args.text ?? ""), args.selector ? String(args.selector) : undefined)),
      },
      {
        name: "browser_press",
        description: "Press a special key in the browser tab (enter, tab, escape, arrows…).",
        tier: "execute",
        parameters: { type: "object", properties: { key: { type: "string", description: "Key name, e.g. enter." } }, required: ["key"] },
        summarize: (args) => `press ${String(args.key ?? "")}`,
        execute: (args) => wrap(() => this.press(String(args.key ?? ""))),
      },
      {
        name: "browser_scroll",
        description: "Scroll the page vertically by a pixel delta (negative = up).",
        tier: "execute",
        parameters: { type: "object", properties: { delta_y: { type: "number", description: "Pixels to scroll (default 600)." } } },
        summarize: (args) => `scroll ${String(args.delta_y ?? 600)}`,
        execute: (args) => wrap(() => this.scroll(Number(args.delta_y) || 600)),
      },
      {
        name: "browser_snapshot",
        description: "Structured snapshot of the current page: title, URL and interactive elements with CSS selectors — use before clicking or typing.",
        tier: "read",
        parameters: { type: "object", properties: {} },
        summarize: () => "snapshot",
        execute: () => wrap(() => this.snapshot()),
      },
      {
        name: "browser_screenshot",
        description: "Capture the browser tab to a PNG file; read the file to view it.",
        tier: "read",
        parameters: { type: "object", properties: {} },
        summarize: () => "screenshot",
        execute: () => wrap(() => this.screenshot()),
      },
      {
        name: "browser_console",
        description: "Tail the browser console log (written to a file, so ask for only the lines you need).",
        tier: "read",
        parameters: { type: "object", properties: { lines: { type: "number", description: "Lines from the end (default 40)." } } },
        summarize: () => "console tail",
        execute: (args) => this.withBrowserTool(async () => this.tailConsole(Number(args.lines) || 40)),
      },
      {
        name: "browser_network",
        description: "Tail the browser network log (responses and failures).",
        tier: "read",
        parameters: { type: "object", properties: { lines: { type: "number", description: "Lines from the end (default 40)." } } },
        summarize: () => "network tail",
        execute: (args) => this.withBrowserTool(async () => this.tailNetwork(Number(args.lines) || 40)),
      },
      {
        name: "browser_tabs",
        description: "List, open, switch, or close browser tabs.",
        tier: "execute",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "open", "switch", "close"] },
            url: { type: "string" },
            tab_id: { type: "number" },
          },
          required: ["action"],
        },
        summarize: (args) => `tabs ${String(args.action ?? "")}`,
        execute: (args) =>
          wrap(() =>
            this.manageTabs(
              String(args.action) as "list" | "open" | "switch" | "close",
              args.url ? String(args.url) : undefined,
              args.tab_id !== undefined ? Number(args.tab_id) : undefined,
            ),
          ),
      },
      {
        name: "browser_fill",
        description: "Fill a form field by selector (clears existing value first).",
        tier: "execute",
        parameters: {
          type: "object",
          properties: { selector: { type: "string" }, value: { type: "string" } },
          required: ["selector", "value"],
        },
        summarize: (args) => `fill ${String(args.selector ?? "")}`,
        execute: (args) => wrap(() => this.fill(String(args.selector ?? ""), String(args.value ?? ""))),
      },
      {
        name: "browser_fill_form",
        description: "Fill multiple form fields at once.",
        tier: "execute",
        parameters: {
          type: "object",
          properties: {
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: { selector: { type: "string" }, value: { type: "string" } },
                required: ["selector", "value"],
              },
            },
          },
          required: ["fields"],
        },
        summarize: () => "fill form",
        execute: (args) => {
          const fields = Array.isArray(args.fields)
            ? (args.fields as Array<{ selector?: string; value?: string }>).map((f) => ({
                selector: String(f.selector ?? ""),
                value: String(f.value ?? ""),
              }))
            : [];
          return wrap(() => this.fillForm(fields));
        },
      },
      {
        name: "browser_hover",
        description: "Hover over an element matching a CSS selector.",
        tier: "execute",
        parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
        summarize: (args) => `hover ${String(args.selector ?? "")}`,
        execute: (args) => wrap(() => this.hover(String(args.selector ?? ""))),
      },
      {
        name: "browser_drag",
        description: "Drag from one CSS selector to another.",
        tier: "execute",
        parameters: {
          type: "object",
          properties: { from_selector: { type: "string" }, to_selector: { type: "string" } },
          required: ["from_selector", "to_selector"],
        },
        summarize: (args) => `drag ${String(args.from_selector ?? "")}`,
        execute: (args) =>
          wrap(() => this.drag(String(args.from_selector ?? ""), String(args.to_selector ?? ""))),
      },
      {
        name: "browser_handle_dialog",
        description: "Accept or dismiss the next JavaScript dialog (alert/confirm/prompt).",
        tier: "execute",
        parameters: {
          type: "object",
          properties: {
            accept: { type: "boolean", description: "true to accept, false to dismiss." },
            prompt_text: { type: "string", description: "Text for prompt dialogs." },
          },
          required: ["accept"],
        },
        summarize: (args) => (args.accept ? "accept dialog" : "dismiss dialog"),
        execute: (args) =>
          wrap(() => this.handleDialog(Boolean(args.accept), args.prompt_text ? String(args.prompt_text) : undefined)),
      },
    ];
  }
}

function normalizeUrl(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

function validateBrowserRef(ref: unknown): string {
  if (typeof ref !== "string" || !/^e\d+$/.test(ref)) {
    throw new Error(`Invalid browser ref: ${String(ref)}`);
  }
  return ref;
}

function appendLine(file: string, line: string): void {
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // Logging must never break the app.
  }
}

function tailFile(file: string, lines: number, label: string): string {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return `No ${label} output captured yet.`;
  }
  const all = raw.split("\n").filter(Boolean);
  if (all.length === 0) return `No ${label} output captured yet.`;
  const n = Math.min(Math.max(1, lines), 200);
  return `${label} log: ${all.length} lines total, last ${Math.min(n, all.length)}:\n${all.slice(-n).join("\n")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clickScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return "ERROR: no element matches " + ${JSON.stringify(selector)};
    el.scrollIntoView({ block: "center" });
    el.click();
    return "Clicked " + ${JSON.stringify(selector)} + " (" + (el.textContent || "").trim().slice(0, 60) + ")";
  })()`;
}

function focusScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return "ERROR: no element matches " + ${JSON.stringify(selector)};
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.select) el.select();
    return "ok";
  })()`;
}

const SNAPSHOT_SCRIPT = `(() => {
  const parts = ["Title: " + document.title, "URL: " + location.href, "", "Interactive elements (ref — selector):"];
  const selectorFor = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const tag = el.tagName.toLowerCase();
    if (el.name) return tag + "[name=\\"" + el.name + "\\"]";
    const cls = (el.className && typeof el.className === "string") ? el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
    const base = cls ? tag + "." + cls : tag;
    const matches = [...document.querySelectorAll(base)];
    const index = matches.indexOf(el);
    return matches.length > 1 ? base + ":nth-of-type(" + (index + 1) + ")" : base;
  };
  const els = document.querySelectorAll("a[href], button, input, select, textarea, [role=button], [onclick]");
  let count = 0;
  for (const el of els) {
    if (count >= 80) { parts.push("… (more elements omitted)"); break; }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const ref = "e" + (count + 1);
    el.setAttribute("data-deyin-ref", ref);
    const text = (el.value || el.textContent || el.placeholder || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 70);
    parts.push("- [" + ref + "] <" + el.tagName.toLowerCase() + "> " + JSON.stringify(text) + " — selector: " + selectorFor(el));
    count++;
  }
  const bodyText = document.body ? document.body.innerText.replace(/\\n{3,}/g, "\\n\\n").slice(0, 3000) : "";
  parts.push("", "Visible text (truncated):", bodyText);
  return parts.join("\\n");
})()`;

function hoverScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return "ERROR: no element matches " + ${JSON.stringify(selector)};
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    return "Hovered " + ${JSON.stringify(selector)};
  })()`;
}

function fillScript(selector: string, value: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return "ERROR: no element matches " + ${JSON.stringify(selector)};
    el.focus();
    if ("value" in el) { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); }
    else el.textContent = ${JSON.stringify(value)};
    return "Filled " + ${JSON.stringify(selector)};
  })()`;
}

function fillFormScript(fields: Array<{ selector: string; value: string }>): string {
  return `(() => {
    const fields = ${JSON.stringify(fields)};
    const results = [];
    for (const f of fields) {
      const el = document.querySelector(f.selector);
      if (!el) { results.push("MISS " + f.selector); continue; }
      if ("value" in el) { el.value = f.value; el.dispatchEvent(new Event("input", { bubbles: true })); }
      else el.textContent = f.value;
      results.push("OK " + f.selector);
    }
    return results.join("\\n");
  })()`;
}

function dragScript(from: string, to: string): string {
  return `(() => {
    const a = document.querySelector(${JSON.stringify(from)});
    const b = document.querySelector(${JSON.stringify(to)});
    if (!a || !b) return "ERROR: element not found";
    const down = new MouseEvent("mousedown", { bubbles: true });
    const up = new MouseEvent("mouseup", { bubbles: true });
    a.dispatchEvent(down);
    b.dispatchEvent(up);
    return "Dragged " + ${JSON.stringify(from)} + " to " + ${JSON.stringify(to)};
  })()`;
}

function clickRefScript(ref: string): string {
  return `(() => {
    const el = document.querySelector("[data-deyin-ref=\\"${ref}\\"]");
    if (!el) return "ERROR: no element with ref " + ${JSON.stringify(ref)} + " — call browser_snapshot first";
    el.scrollIntoView({ block: "center" });
    el.click();
    return "Clicked ref " + ${JSON.stringify(ref)};
  })()`;
}
