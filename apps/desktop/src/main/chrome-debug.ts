import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "@deyin/agent-core";

const execFileAsync = promisify(execFile);

const CHROME_PATHS_WIN = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
];

type PwPage = {
  url: () => Promise<string>;
  title: () => Promise<string>;
  click: (sel: string) => Promise<void>;
  fill: (sel: string, value: string) => Promise<void>;
  hover: (sel: string) => Promise<void>;
  evaluate: <T>(fn: string | (() => T)) => Promise<T>;
  goto: (url: string) => Promise<void>;
  screenshot: (opts?: { path?: string }) => Promise<Buffer>;
  keyboard: { press: (key: string) => Promise<void>; type: (text: string) => Promise<void> };
  locator: (sel: string) => { fill: (v: string) => Promise<void> };
};

type PwBrowser = {
  pages: () => Promise<PwPage[]>;
  newPage: () => Promise<PwPage>;
  contexts: () => { pages: () => PwPage[] }[];
};

export type ChromeConsentRequester = () => Promise<boolean>;

interface ConsentFile {
  granted: boolean;
  grantedAt?: number;
}

interface OriginsFile {
  origins: string[];
}

/** Attach to user's Chrome via CDP (Windows v1). */
export class ChromeDebugService {
  private port = 0;
  private browser: PwBrowser | null = null;
  private readonly dataDir: string;
  private readonly consentPath: string;
  private readonly originsPath: string;
  private approved = new Set<string>();

  constructor(
    private readonly isEnabled: () => boolean,
    private readonly isWindows: () => boolean,
    private readonly requestConsent: ChromeConsentRequester,
    userDataRoot: string,
  ) {
    this.dataDir = join(userDataRoot, "chrome-debug");
    this.consentPath = join(this.dataDir, "consent.json");
    this.originsPath = join(this.dataDir, "origins.json");
    mkdirSync(this.dataDir, { recursive: true });
    this.loadConsent();
    this.loadOrigins();
  }

  approvedOrigins(): Set<string> {
    return new Set(this.approved);
  }

  approveOrigin(origin: string): void {
    this.approved.add(origin);
    writeFileSync(this.originsPath, JSON.stringify({ origins: [...this.approved] } satisfies OriginsFile, null, 2));
  }

  private loadConsent(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.consentPath, "utf8")) as ConsentFile;
      if (parsed.granted) return;
    } catch {
      // no consent yet
    }
  }

  private hasConsent(): boolean {
    try {
      return (JSON.parse(readFileSync(this.consentPath, "utf8")) as ConsentFile).granted === true;
    } catch {
      return false;
    }
  }

  private async ensureConsent(): Promise<void> {
    if (this.hasConsent()) return;
    const granted = await this.requestConsent();
    if (!granted) throw new Error("Chrome automation consent denied.");
    writeFileSync(this.consentPath, JSON.stringify({ granted: true, grantedAt: Date.now() } satisfies ConsentFile));
  }

  private loadOrigins(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.originsPath, "utf8")) as OriginsFile;
      this.approved = new Set(parsed.origins ?? []);
    } catch {
      this.approved = new Set();
    }
  }

  private chromePath(): string | null {
    for (const p of CHROME_PATHS_WIN) {
      if (p && existsSync(p)) return p;
    }
    return null;
  }

  private userDataDir(): string {
    return join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");
  }

  private async probePort(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async pickPort(): Promise<number> {
    for (let port = 9222; port <= 9232; port++) {
      if (await this.probePort(port)) return port;
    }
    for (let port = 9222; port <= 9232; port++) {
      if (!(await this.probePort(port))) return port;
    }
    return 9222;
  }

  private async connectCdp(): Promise<PwBrowser> {
    const pw = await import("playwright-core");
    return (await pw.chromium.connectOverCDP(`http://127.0.0.1:${this.port}`)) as unknown as PwBrowser;
  }

  private async chromeRunning(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    try {
      const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"]);
      return stdout.toLowerCase().includes("chrome.exe");
    } catch {
      return false;
    }
  }

  private async ensureChrome(): Promise<void> {
    if (!this.isEnabled()) throw new Error("Chrome automation is disabled. Enable it in Settings → Chrome.");
    if (!this.isWindows()) throw new Error("Chrome CDP attach is available on Windows in v1.");
    await this.ensureConsent();
    if (this.browser) return;

    this.port = await this.pickPort();
    if (!(await this.probePort(this.port))) {
      if (await this.chromeRunning()) {
        throw new Error(
          "Chrome is running without remote debugging. Close Chrome completely, then retry so Deyin can attach with your Default profile.",
        );
      }
      const chrome = this.chromePath();
      if (!chrome) throw new Error("Google Chrome not found.");
      const userDataDir = this.userDataDir();
      spawn(
        chrome,
        [
          `--remote-debugging-port=${this.port}`,
          `--user-data-dir=${userDataDir}`,
          "--profile-directory=Default",
          "--no-first-run",
          "--no-default-browser-check",
        ],
        { detached: true, stdio: "ignore", windowsHide: true },
      ).unref();
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (await this.probePort(this.port)) break;
      }
    }
    this.browser = await this.connectCdp();
  }

  private async page(): Promise<PwPage> {
    await this.ensureChrome();
    const contexts = this.browser!.contexts();
    for (const ctx of contexts) {
      const pages = ctx.pages();
      if (pages.length > 0) return pages[0]!;
    }
    const pages = await this.browser!.pages();
    if (pages.length > 0) return pages[0]!;
    return this.browser!.newPage();
  }

  private async navigate(url: string): Promise<string> {
    const normalized = /^https?:\/\//.test(url) ? url : `https://${url}`;
    const p = await this.page();
    await p.goto(normalized);
    return `Loaded ${await p.url()} — "${await p.title()}"`;
  }

  async dispose(): Promise<void> {
    const browser = this.browser as (PwBrowser & { close?: () => Promise<void> }) | null;
    this.browser = null;
    this.port = 0;
    if (browser?.close) {
      try {
        await browser.close();
      } catch {
        // ignore disconnect errors
      }
    }
  }

  tools(): ToolDefinition[] {
    const wrap = (fn: () => Promise<string>): Promise<string> =>
      fn().catch((err) => `ERROR: ${err instanceof Error ? err.message : String(err)}`);
    const mk = (
      name: string,
      description: string,
      tier: "read" | "execute",
      props: Record<string, unknown>,
      required: string[],
      run: (args: Record<string, unknown>) => Promise<string>,
      summarize: (args: Record<string, unknown>) => string,
    ): ToolDefinition => ({
      name,
      description,
      tier,
      parameters: { type: "object", properties: props, required },
      summarize,
      execute: (args) => wrap(() => run(args)),
    });

    return [
      mk("chrome_navigate", "Open a URL in the user's Chrome browser.", "execute", { url: { type: "string" } }, ["url"], async (args) => this.navigate(String(args.url ?? "")), (args) => String(args.url ?? "")),
      mk("chrome_snapshot", "Structured snapshot with ref ids.", "read", {}, [], async () => {
        const p = await this.page();
        const script = `(() => {
          const parts = ["Title: " + document.title, "URL: " + location.href, "", "Interactive:"];
          let n = 0;
          for (const el of document.querySelectorAll("a,button,input,select,textarea,[role=button]")) {
            if (n++ > 80) break;
            const ref = "c" + n;
            el.setAttribute("data-deyin-ref", ref);
            const t = (el.textContent || el.value || "").trim().slice(0, 60);
            parts.push("- [" + ref + "] " + el.tagName + " " + t);
          }
          return parts.join("\\n");
        })()`;
        return (await p.evaluate(script)) as string;
      }, () => "snapshot"),
      mk("chrome_click", "Click element by CSS selector or ref.", "execute", { selector: { type: "string" }, ref: { type: "string" } }, [], async (args) => {
        const p = await this.page();
        const sel = args.ref ? `[data-deyin-ref="${validateChromeRef(args.ref)}"]` : String(args.selector ?? "");
        await p.click(sel);
        return `Clicked ${sel}`;
      }, (args) => String(args.selector ?? args.ref ?? "")),
      mk("chrome_type", "Type text into Chrome.", "execute", { text: { type: "string" }, selector: { type: "string" }, ref: { type: "string" } }, ["text"], async (args) => {
        const p = await this.page();
        const sel = args.ref ? `[data-deyin-ref="${validateChromeRef(args.ref)}"]` : args.selector ? String(args.selector) : undefined;
        if (sel) await p.click(sel);
        await p.keyboard.type(String(args.text ?? ""));
        return "Typed into Chrome";
      }, (args) => `type ${String(args.text ?? "").slice(0, 40)}`),
      mk("chrome_fill", "Fill an input by selector or ref.", "execute", { selector: { type: "string" }, ref: { type: "string" }, value: { type: "string" } }, ["value"], async (args) => {
        const p = await this.page();
        const sel = args.ref ? `[data-deyin-ref="${String(args.ref)}"]` : String(args.selector ?? "");
        await p.fill(sel, String(args.value ?? ""));
        return `Filled ${sel}`;
      }, (args) => `fill ${String(args.selector ?? args.ref ?? "")}`),
      mk("chrome_hover", "Hover an element.", "execute", { selector: { type: "string" }, ref: { type: "string" } }, [], async (args) => {
        const p = await this.page();
        const sel = args.ref ? `[data-deyin-ref="${String(args.ref)}"]` : String(args.selector ?? "");
        await p.hover(sel);
        return `Hovered ${sel}`;
      }, (args) => `hover ${String(args.selector ?? args.ref ?? "")}`),
      mk("chrome_press", "Press a key in Chrome.", "execute", { key: { type: "string" } }, ["key"], async (args) => {
        const p = await this.page();
        await p.keyboard.press(String(args.key ?? ""));
        return `Pressed ${String(args.key ?? "")}`;
      }, (args) => `press ${String(args.key ?? "")}`),
      mk("chrome_scroll", "Scroll the page.", "execute", { delta_y: { type: "number" } }, [], async (args) => {
        const p = await this.page();
        await p.evaluate(`window.scrollBy(0, ${Number(args.delta_y) || 600})`);
        return "Scrolled";
      }, (args) => `scroll ${String(args.delta_y ?? 0)}`),
      mk("chrome_screenshot", "Capture a PNG screenshot.", "read", { path: { type: "string" } }, [], async (args) => {
        const p = await this.page();
        const path = args.path ? String(args.path) : join(this.dataDir, `shot-${Date.now()}.png`);
        await p.screenshot({ path });
        return `Screenshot saved to ${path}`;
      }, () => "screenshot"),
      mk("chrome_tabs", "List open Chrome tabs.", "read", {}, [], async () => {
        await this.ensureChrome();
        const tabs: { index: number; title: string; url: string }[] = [];
        let i = 0;
        for (const ctx of this.browser!.contexts()) {
          for (const p of ctx.pages()) {
            tabs.push({ index: i++, title: await p.title(), url: await p.url() });
          }
        }
        return JSON.stringify(tabs, null, 2);
      }, () => "tabs"),
      mk("chrome_console", "Read recent console messages.", "read", {}, [], async () => "(console capture requires active CDP session)", () => "console"),
      mk("chrome_network", "Summarize recent network activity.", "read", {}, [], async () => "(network capture requires active CDP session)", () => "network"),
    ];
  }
}

function validateChromeRef(ref: unknown): string {
  const s = String(ref ?? "");
  if (!/^c\d+$/.test(s)) {
    throw new Error(`Invalid chrome ref "${s}" — expected format c1, c2, … from chrome_snapshot.`);
  }
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
