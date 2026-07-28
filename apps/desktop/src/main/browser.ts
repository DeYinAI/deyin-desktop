import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, app, session, webContents, type WebContents } from "electron";
import type { ToolDefinition } from "@deyin/agent-core";
import { CH } from "../shared/ipc.js";

/**
 * Real browser control (Cursor-style): the agent drives the workspace panel's
 * <webview> through main-process tools. Console and network activity stream to
 * log files the agent tails selectively; screenshots go to files. The webview
 * uses a per-workspace persistent session partition, so logins survive
 * restarts and stay isolated between workspaces.
 */

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

export function workspacePartition(root: string | null): string {
  const hash = createHash("sha256").update(root ?? "default").digest("hex").slice(0, 12);
  return `persist:deyin-ws-${hash}`;
}

export class BrowserControlService {
  private wcId: number | null = null;
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

  register(webContentsId: number | null): void {
    if (webContentsId === null) {
      this.wcId = null;
      return;
    }
    // The renderer re-announces on every dom-ready; only attach once per target.
    if (this.wcId === webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc) return;
    this.wcId = webContentsId;
    this.attachLogging(wc);
    wc.once("destroyed", () => {
      if (this.wcId === webContentsId) this.wcId = null;
    });
  }

  private consoleLogFile(): string {
    return join(this.logDir, "console.log");
  }

  private networkLogFile(): string {
    return join(this.logDir, "network.log");
  }

  private attachLogging(wc: WebContents): void {
    // Reset logs per registration so tails reflect the current page session.
    writeFileSync(this.consoleLogFile(), "");
    writeFileSync(this.networkLogFile(), "");

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

  /* Target acquisition -------------------------------------------------------- */

  private async target(): Promise<WebContents> {
    if (!this.isEnabled()) {
      throw new Error("Browser control is disabled. Enable it in Settings → Browser.");
    }
    let wc = this.wcId !== null ? webContents.fromId(this.wcId) : null;
    if (wc && !wc.isDestroyed()) return wc;

    // Ask the renderer to open the Browser tab, then wait for registration.
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CH.browserEnsure);
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      wc = this.wcId !== null ? webContents.fromId(this.wcId) : null;
      if (wc && !wc.isDestroyed()) return wc;
    }
    throw new Error("No browser tab available. Open the Browser tab in the workspace panel and retry.");
  }

  /* Actions ------------------------------------------------------------------ */

  async navigate(url: string): Promise<string> {
    const wc = await this.target();
    const target = /^https?:\/\//.test(url) ? url : `https://${url}`;
    await wc.loadURL(target);
    return `Loaded ${wc.getURL()} — "${wc.getTitle()}"`;
  }

  async click(selector: string): Promise<string> {
    const wc = await this.target();
    const result = (await wc.executeJavaScript(clickScript(selector), true)) as string;
    return result;
  }

  async type(text: string, selector?: string): Promise<string> {
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
  }

  async press(key: string): Promise<string> {
    const wc = await this.target();
    const mapped = KEY_MAP[key.toLowerCase()];
    if (!mapped) return `ERROR: unsupported key "${key}". Supported: ${Object.keys(KEY_MAP).join(", ")}.`;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      const base = { key: mapped.keyCode, code: mapped.keyCode, windowsVirtualKeyCode: mapped.windowsVirtualKeyCode, nativeVirtualKeyCode: mapped.windowsVirtualKeyCode };
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    } catch (err) {
      return `ERROR: could not press: ${err instanceof Error ? err.message : String(err)}`;
    }
    return `Pressed ${key}`;
  }

  async scroll(deltaY: number): Promise<string> {
    const wc = await this.target();
    await wc.executeJavaScript(`window.scrollBy({ top: ${Number(deltaY) || 600}, behavior: "instant" }); "ok"`, true);
    return `Scrolled by ${deltaY}px (now at ${(await wc.executeJavaScript("window.scrollY", true)) as number}px)`;
  }

  async screenshot(): Promise<string> {
    const wc = await this.target();
    const image = await wc.capturePage();
    const file = join(this.shotDir, `shot-${Date.now()}.png`);
    writeFileSync(file, image.toPNG());
    return `Screenshot saved to ${file}. Read that file to view it.`;
  }

  async snapshot(): Promise<string> {
    const wc = await this.target();
    const result = (await wc.executeJavaScript(SNAPSHOT_SCRIPT, true)) as string;
    return result.length > 12_000 ? `${result.slice(0, 12_000)}\n… (truncated)` : result;
  }

  async currentUrl(): Promise<string> {
    const wc = await this.target();
    return `${wc.getURL()} — "${wc.getTitle()}"`;
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
        description: "Click the first element matching a CSS selector in the browser tab.",
        tier: "execute",
        parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector." } }, required: ["selector"] },
        summarize: (args) => String(args.selector ?? ""),
        execute: (args) => wrap(() => this.click(String(args.selector ?? ""))),
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
        execute: (args) => Promise.resolve(this.tailConsole(Number(args.lines) || 40)),
      },
      {
        name: "browser_network",
        description: "Tail the browser network log (responses and failures).",
        tier: "read",
        parameters: { type: "object", properties: { lines: { type: "number", description: "Lines from the end (default 40)." } } },
        summarize: () => "network tail",
        execute: (args) => Promise.resolve(this.tailNetwork(Number(args.lines) || 40)),
      },
    ];
  }
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
  const parts = ["Title: " + document.title, "URL: " + location.href, "", "Interactive elements:"];
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
    const text = (el.value || el.textContent || el.placeholder || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 70);
    parts.push("- <" + el.tagName.toLowerCase() + "> " + JSON.stringify(text) + " — selector: " + selectorFor(el));
    count++;
  }
  const bodyText = document.body ? document.body.innerText.replace(/\\n{3,}/g, "\\n\\n").slice(0, 3000) : "";
  parts.push("", "Visible text (truncated):", bodyText);
  return parts.join("\\n");
})()`;
