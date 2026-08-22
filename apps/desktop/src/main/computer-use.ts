import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut } from "electron";
import type { ToolDefinition } from "@deyin/agent-core";
import { createComputerUseHost, PipeComputerUseHost, type ComputerUseHostApi } from "@deyin/computer-use-host";
import { CH } from "@deyin/contract";

interface AllowlistFile {
  apps: string[];
}

interface WindowRow {
  id?: string;
  title?: string;
  app?: string;
}

/** OS-level computer use — Windows native host with mock on other platforms. */
export class ComputerUseService {
  private host: ComputerUseHostApi | null = null;
  private abortController: AbortController | null = null;
  private shortcutsRegistered = false;
  private readonly dataDir: string;
  private readonly shotsDir: string;
  private readonly allowlistPath: string;
  private readonly getRetentionDays: () => number;
  private appApprovalResolver: ((req: { appId: string; action: string }) => Promise<"always" | "once" | "deny">) | null =
    null;

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
  }

  setAppApprovalResolver(
    resolver: (req: { appId: string; action: string }) => Promise<"always" | "once" | "deny">,
  ): void {
    this.appApprovalResolver = resolver;
  }

  registerShortcuts(): void {
    // Registered lazily while automation is active.
  }

  unregisterShortcuts(): void {
    try {
      if (this.shortcutsRegistered) globalShortcut.unregister("Escape");
    } catch {
      // ignore
    }
    this.shortcutsRegistered = false;
  }

  private registerEscShortcut(): void {
    if (this.shortcutsRegistered) return;
    try {
      globalShortcut.register("Escape", () => {
        void this.cancelActive();
      });
      this.shortcutsRegistered = true;
    } catch {
      // headless / duplicate registration
    }
  }

  private async cancelActive(): Promise<void> {
    this.abortController?.abort();
    if (this.host && "cancel" in this.host && typeof this.host.cancel === "function") {
      await this.host.cancel().catch(() => undefined);
    }
    this.setActive(false);
  }

  private setActive(active: boolean): void {
    if (active) this.registerEscShortcut();
    else this.unregisterShortcuts();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.computerUseActive, active);
    }
  }

  private ensureHost(): ComputerUseHostApi {
    if (!this.isEnabled()) throw new Error("Computer use is disabled. Enable it in Settings → Computer Use.");
    if (!this.isWindows()) throw new Error("Computer use is available on Windows only.");
    if (!this.host) {
      this.host = createComputerUseHost({
        shotsDir: this.shotsDir,
        resourcesPath: process.resourcesPath,
      });
    }
    if (this.host instanceof PipeComputerUseHost) {
      this.host.setAbortSignal(this.abortController?.signal);
    }
    return this.host;
  }

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

  async listAppsPreview(): Promise<unknown> {
    return this.ensureHost().listApps();
  }

  private async ensureWindowAllowed(windowId: string): Promise<void> {
    const windows = (await this.ensureHost().listWindows()) as WindowRow[];
    const row = windows.find((w) => w.id === windowId);
    const appId = row?.app ?? "";
    if (!appId) {
      throw new Error(`Window "${windowId}" has no associated app; cannot verify permission.`);
    }
    await this.ensureAppAllowed(appId, "interact");
  }

  private async ensureAppAllowed(appId: string, action: string): Promise<void> {
    if (this.isAppAllowed(appId)) return;
    if (!this.appApprovalResolver) {
      throw new Error(
        `App "${appId}" is not on the always-allow list and no approval prompt is available. Add it in Settings → Computer Use.`,
      );
    }
    let decision: "always" | "once" | "deny";
    try {
      decision = await this.appApprovalResolver({ appId, action });
    } catch {
      throw new Error(`App "${appId}" approval request failed. Try again or add it in Settings → Computer Use.`);
    }
    if (decision === "deny") {
      throw new Error(`App "${appId}" was denied for computer use.`);
    }
    if (decision === "always") {
      this.setAllowlist([...this.getAllowlist(), appId]);
    }
  }

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
    const withChain = async (fn: () => Promise<string>): Promise<string> => {
      this.abortController = new AbortController();
      this.setActive(true);
      try {
        if (this.abortController.signal.aborted) throw new Error("Computer use cancelled (Esc).");
        return await fn();
      } finally {
        this.setActive(false);
        this.abortController = null;
      }
    };

    return [
      {
        name: "computer_list_apps",
        description: "List installed/running applications available for automation.",
        tier: "read",
        parameters: { type: "object", properties: {} },
        summarize: () => "list apps",
        execute: () => withChain(async () => JSON.stringify(await this.ensureHost().listApps(), null, 2)),
      },
      {
        name: "computer_list_windows",
        description: "List open desktop windows with ids and titles.",
        tier: "read",
        parameters: { type: "object", properties: {} },
        summarize: () => "list windows",
        execute: () => withChain(async () => JSON.stringify(await this.ensureHost().listWindows(), null, 2)),
      },
      {
        name: "computer_get_state",
        description: "Capture window screenshot and accessibility tree refs for interaction.",
        tier: "read",
        parameters: {
          type: "object",
          properties: {
            window_id: { type: "string", description: "Window id from list_windows." },
            screenshot: { type: "boolean", description: "Include screenshot path (default true)." },
            tree: { type: "boolean", description: "Include a11y tree (default true)." },
          },
          required: ["window_id"],
        },
        summarize: (args) => `state ${String(args.window_id ?? "")}`,
        execute: (args) =>
          withChain(async () => {
            const windowId = String(args.window_id ?? "");
            await this.ensureWindowAllowed(windowId);
            return JSON.stringify(
              await this.ensureHost().getWindowState(windowId, {
                screenshot: args.screenshot !== false,
                tree: args.tree !== false,
              }),
              null,
              2,
            );
          }),
      },
      {
        name: "computer_launch_app",
        description: "Launch an application by id or executable name.",
        tier: "execute",
        parameters: {
          type: "object",
          properties: { app_id: { type: "string", description: "App id or executable." } },
          required: ["app_id"],
        },
        summarize: (args) => `launch ${String(args.app_id ?? "")}`,
        execute: (args) =>
          withChain(async () => {
            const appId = String(args.app_id ?? "");
            await this.ensureAppAllowed(appId, "launch");
            return JSON.stringify(await this.ensureHost().launchApp(appId), null, 2);
          }),
      },
      {
        name: "computer_click",
        description: "Click an element by ref from get_state.",
        tier: "execute",
        parameters: {
          type: "object",
          properties: {
            window_id: { type: "string" },
            ref: { type: "string", description: "Element ref from accessibility tree." },
          },
          required: ["window_id", "ref"],
        },
        summarize: (args) => `click ${String(args.ref ?? "")}`,
        execute: (args) =>
          withChain(async () => {
            const windowId = String(args.window_id ?? "");
            await this.ensureWindowAllowed(windowId);
            return JSON.stringify(await this.ensureHost().click(windowId, String(args.ref)), null, 2);
          }),
      },
      {
        name: "computer_type",
        description: "Type text into the focused element or a ref.",
        tier: "execute",
        parameters: {
          type: "object",
          properties: {
            window_id: { type: "string" },
            text: { type: "string" },
            ref: { type: "string" },
          },
          required: ["window_id", "text"],
        },
        summarize: (args) => `type ${String(args.text ?? "").slice(0, 40)}`,
        execute: (args) =>
          withChain(async () => {
            const windowId = String(args.window_id ?? "");
            await this.ensureWindowAllowed(windowId);
            return JSON.stringify(
              await this.ensureHost().typeText(windowId, String(args.text), args.ref ? String(args.ref) : undefined),
              null,
              2,
            );
          }),
      },
      {
        name: "computer_press_key",
        description: "Press a keyboard key in the target window.",
        tier: "execute",
        parameters: {
          type: "object",
          properties: { window_id: { type: "string" }, key: { type: "string" } },
          required: ["window_id", "key"],
        },
        summarize: (args) => `press ${String(args.key ?? "")}`,
        execute: (args) =>
          withChain(async () => {
            const windowId = String(args.window_id ?? "");
            await this.ensureWindowAllowed(windowId);
            return JSON.stringify(await this.ensureHost().pressKey(windowId, String(args.key)), null, 2);
          }),
      },
      {
        name: "computer_scroll",
        description: "Scroll vertically in the target window.",
        tier: "execute",
        parameters: {
          type: "object",
          properties: { window_id: { type: "string" }, delta_y: { type: "number" } },
          required: ["window_id"],
        },
        summarize: (args) => `scroll ${String(args.delta_y ?? 0)}`,
        execute: (args) =>
          withChain(async () => {
            const windowId = String(args.window_id ?? "");
            await this.ensureWindowAllowed(windowId);
            return JSON.stringify(await this.ensureHost().scroll(windowId, Number(args.delta_y) || 600), null, 2);
          }),
      },
      {
        name: "computer_drag",
        description: "Drag from one element ref to another.",
        tier: "execute",
        parameters: {
          type: "object",
          properties: {
            window_id: { type: "string" },
            from_ref: { type: "string" },
            to_ref: { type: "string" },
          },
          required: ["window_id", "from_ref", "to_ref"],
        },
        summarize: (args) => `drag ${String(args.from_ref ?? "")} → ${String(args.to_ref ?? "")}`,
        execute: (args) =>
          withChain(async () => {
            const windowId = String(args.window_id ?? "");
            await this.ensureWindowAllowed(windowId);
            return JSON.stringify(
              await this.ensureHost().drag(windowId, String(args.from_ref), String(args.to_ref)),
              null,
              2,
            );
          }),
      },
      {
        name: "computer_set_value",
        description: "Set the value of a text field by ref (UIA ValuePattern).",
        tier: "execute",
        parameters: {
          type: "object",
          properties: {
            window_id: { type: "string" },
            ref: { type: "string" },
            value: { type: "string" },
          },
          required: ["window_id", "ref", "value"],
        },
        summarize: (args) => `set value ${String(args.ref ?? "")}`,
        execute: (args) =>
          withChain(async () => {
            const windowId = String(args.window_id ?? "");
            await this.ensureWindowAllowed(windowId);
            return JSON.stringify(
              await this.ensureHost().setValue(windowId, String(args.ref), String(args.value)),
              null,
              2,
            );
          }),
      },
    ];
  }
}
