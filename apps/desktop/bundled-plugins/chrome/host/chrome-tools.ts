import type { ToolContext, ToolDefinition } from "@deyin/agent-core";
import type { ClickOptions, CdpPage, PointTarget } from "../../browser/host/cdp-page.js";
import type { ChromeControl } from "./chrome-control.js";
import type { ExtTab } from "./chrome-protocol.js";

/**
 * `chrome_*` agent tools: drive tabs in the user's real Chrome through the
 * Deyin extension. Work happens in background tabs Deyin opened (or tabs the
 * user shared); the user's own tabs and focus are not touched.
 */

const ACTION_TYPES = ["click", "hover", "type", "fill", "press", "select", "scroll", "drag", "wait"] as const;
type ActionType = (typeof ACTION_TYPES)[number];

const MODIFIERS = ["alt", "ctrl", "meta", "shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

const MAX_BATCH_STEPS = 12;
const SETTLE_AFTER_ACTION_MS = 300;

type Args = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function modifiersOf(v: unknown): Modifier[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((m): m is Modifier => typeof m === "string" && (MODIFIERS as readonly string[]).includes(m));
  return out.length ? out : undefined;
}

function pointOf(args: Args, prefix = ""): PointTarget {
  const ref = str(args[`${prefix}ref`]);
  if (ref) return { ref };
  const x = num(args[`${prefix}x`]);
  const y = num(args[`${prefix}y`]);
  if (x !== undefined && y !== undefined) return { x, y };
  throw new Error(`Provide ${prefix}ref (from chrome_snapshot) or ${prefix}x and ${prefix}y.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Perform one interaction. Shared by the individual tools and chrome_batch. */
async function perform(page: CdpPage, type: ActionType, args: Args): Promise<string> {
  switch (type) {
    case "click": {
      const modifiers = modifiersOf(args.modifiers);
      const button = args.button === "right" || args.button === "middle" ? args.button : "left";
      const opts: ClickOptions = { button, count: args.double === true ? 2 : 1, ...(modifiers ? { modifiers } : {}) };
      return page.click(pointOf(args), opts);
    }
    case "hover":
      return page.hover(pointOf(args));
    case "type": {
      const text = args.text;
      if (typeof text !== "string") throw new Error("text is required.");
      return page.type(text, str(args.ref), args.submit === true);
    }
    case "fill": {
      const fields = Array.isArray(args.fields) ? (args.fields as Args[]) : [{ ref: args.ref, value: args.value }];
      const results: string[] = [];
      for (const [i, field] of fields.entries()) {
        const ref = str(field.ref);
        if (!ref || typeof field.value !== "string") throw new Error(`fill field ${i + 1} needs ref and value.`);
        const last = i === fields.length - 1;
        results.push(await page.fill(ref, field.value, last && args.submit === true));
      }
      return results.join("\n");
    }
    case "press": {
      const key = str(args.key);
      if (!key) throw new Error("key is required (e.g. Enter, Escape, Control+A).");
      return page.press(key);
    }
    case "select": {
      const ref = str(args.ref);
      const values = Array.isArray(args.values) ? args.values.filter((v): v is string => typeof v === "string") : [];
      if (!ref || values.length === 0) throw new Error("select needs ref and values.");
      return page.select(ref, values);
    }
    case "scroll":
      return page.scroll({
        ...(str(args.ref) ? { ref: str(args.ref) as string } : {}),
        ...(num(args.delta_x) !== undefined ? { deltaX: num(args.delta_x) as number } : {}),
        ...(num(args.delta_y) !== undefined ? { deltaY: num(args.delta_y) as number } : {}),
      });
    case "drag":
      return page.drag(pointOf(args, "from_"), pointOf(args, "to_"));
    case "wait":
      return page.waitFor({
        ...(num(args.ms) !== undefined ? { ms: num(args.ms) as number } : {}),
        ...(str(args.text) ? { text: str(args.text) as string } : {}),
        ...(str(args.text_gone) ? { textGone: str(args.text_gone) as string } : {}),
        ...(num(args.timeout_ms) !== undefined ? { timeoutMs: num(args.timeout_ms) as number } : {}),
      });
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown action: ${String(_exhaustive)}`);
    }
  }
}

export function createChromeTools(control: ChromeControl): ToolDefinition[] {
  const threadOf = (ctx: ToolContext | undefined): string | undefined => ctx?.sessionMeta?.threadId;
  const tabOf = (args: Args): number | undefined => num(args.tab_id);
  const fail = (err: unknown): string => `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  const guard = async (fn: () => Promise<string>): Promise<string> => {
    try {
      return await fn();
    } catch (err) {
      return fail(err);
    }
  };

  /** What changed on the page because of an action: navigation or an opened dialog. */
  const aftermath = async (page: CdpPage, tabId: number, before: string): Promise<string> => {
    await sleep(SETTLE_AFTER_ACTION_MS);
    const notes: string[] = [];
    const url = control.status().tabs.find((t) => t.id === tabId)?.url;
    if (url && url !== before) notes.push(`Page is now ${url}`);
    const dialog = page.pendingDialog();
    if (dialog) notes.push(`A ${dialog.type} dialog is open: ${JSON.stringify(dialog.message.slice(0, 120))}. Resolve it with chrome_dialog.`);
    return notes.length ? `\n${notes.join("\n")}` : "";
  };

  const action = (type: ActionType) => (args: Args, ctx: ToolContext) =>
    guard(() =>
      control.withPage(
        threadOf(ctx),
        tabOf(args),
        type,
        async (page, tab) => {
          const result = await perform(page, type, args);
          return result + (type === "wait" ? "" : await aftermath(page, tab.id, tab.url));
        },
        { ...(ctx.signal ? { signal: ctx.signal } : {}) },
      ),
    );

  const describeTab = (tab: ExtTab, current: number | undefined): string =>
    `- ${tab.id} [${tab.shared ? "shared" : "deyin"}] ${JSON.stringify(tab.title || "(untitled)")} ${tab.url}${tab.attached ? " (attached)" : ""}${tab.id === current ? " (current)" : ""}`;

  const tabIdProp = { tab_id: { type: "number", description: "Tab id from chrome_tabs. Defaults to the current tab." } };
  const refProp = { type: "string", description: "Element ref from chrome_snapshot, e.g. e12." };

  return [
    {
      name: "chrome_status",
      description:
        "Show whether Deyin is connected to the user's Chrome and which tabs this conversation can use. Call this first if a chrome_* tool says Chrome is not connected.",
      tier: "read",
      parameters: { type: "object", properties: {} },
      summarize: () => "chrome status",
      execute: async (_args, ctx) => {
        const s = control.status();
        const thread = threadOf(ctx) ?? "default";
        const lines: string[] = [];
        if (!s.listening) lines.push(`Relay: not running${s.error ? ` (${s.error})` : ""}`);
        else if (s.connection === "connected") lines.push(`Chrome: connected (${s.browser?.label ?? "browser"})${s.stopped ? " — STOPPED by the user" : ""}`);
        else if (s.paired.length > 0) lines.push("Chrome: not connected. Open Chrome with the Deyin extension enabled; it reconnects on its own.");
        else lines.push("Chrome: not paired. The user must install the Deyin extension and pair it in Settings → Chrome.");
        const tabs = control.tabsFor(thread);
        lines.push(tabs.length ? "Tabs you can use:" : "No tabs yet. Use chrome_open, or ask the user to share a tab from the extension popup.");
        for (const tab of tabs) lines.push(describeTab(tab, control.currentTabId(thread)));
        return lines.join("\n");
      },
    },
    {
      name: "chrome_open",
      description:
        "Open a URL in a NEW background tab in the user's Chrome (grouped as \"Deyin\"; it does not steal focus or touch the user's tabs). Returns the tab id; later chrome_* calls use it automatically. Prefer this over chrome_navigate on an existing tab.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open. Omit for a blank tab." },
          reveal: { type: "boolean", description: "Bring the tab to the front. Only when the user asked to see it." },
        },
      },
      summarize: (args) => `open ${String(args.url ?? "blank tab")}`,
      execute: (args, ctx) =>
        guard(async () => {
          const thread = threadOf(ctx);
          const url = str(args.url);
          // Ask about the origin before creating anything, so a refusal leaves no stray tab.
          if (url) await control.ensureOriginAllowed(thread ?? "default", url, "open");
          const tab = await control.open(thread ?? "default", args.reveal === true);
          if (!url) return `Opened blank tab ${tab.id}.`;
          try {
            return await control.withPage(
              thread,
              tab.id,
              "open",
              async (page) => {
                await page.navigate(url);
                await control.verifyLanded(thread, tab.id, page);
                const info = await page.info();
                return `Opened tab ${tab.id}: ${JSON.stringify(info.title)} — ${info.url}\nUse chrome_snapshot to read it.`;
              },
              { checkCurrentOrigin: false, ...(ctx.signal ? { signal: ctx.signal } : {}) },
            );
          } catch (err) {
            // Don't strand an empty tab in the user's browser when the first load failed.
            await control.closeTab(thread ?? "default", tab.id).catch(() => undefined);
            throw err;
          }
        }),
    },
    {
      name: "chrome_tabs",
      description: "List the Chrome tabs you can use, switch the current tab, close a tab Deyin opened, or bring a tab to the front.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: { action: { type: "string", enum: ["list", "use", "close", "reveal"] }, ...tabIdProp },
        required: ["action"],
      },
      summarize: (args) => `tabs ${String(args.action ?? "")}${args.tab_id !== undefined ? ` ${String(args.tab_id)}` : ""}`,
      execute: (args, ctx) =>
        guard(async () => {
          const thread = threadOf(ctx) ?? "default";
          const id = tabOf(args);
          const needId = (): number => {
            if (id === undefined) throw new Error("tab_id is required.");
            return id;
          };
          switch (args.action) {
            case "list": {
              const tabs = control.tabsFor(thread);
              return tabs.length ? tabs.map((t) => describeTab(t, control.currentTabId(thread))).join("\n") : "No tabs yet.";
            }
            case "use":
              return `Using tab ${control.useTab(thread, needId()).id}.`;
            case "close":
              await control.closeTab(thread, needId());
              return `Closed tab ${needId()}.`;
            case "reveal":
              await control.revealTab(thread, needId());
              return `Brought tab ${needId()} to the front.`;
            default:
              throw new Error("action must be list, use, close or reveal.");
          }
        }),
    },
    {
      name: "chrome_navigate",
      description: "Navigate the current Chrome tab to a URL, or go back / forward / reload. Opening a new site for the first time asks the user to approve its origin.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to load." },
          action: { type: "string", enum: ["back", "forward", "reload"], description: "Use instead of url." },
          ...tabIdProp,
        },
      },
      summarize: (args) => String(args.url ?? args.action ?? ""),
      execute: (args, ctx) =>
        guard(async () => {
          const thread = threadOf(ctx);
          const url = str(args.url);
          const nav = args.action;
          if (!url && nav !== "back" && nav !== "forward" && nav !== "reload") throw new Error("Provide url, or action: back, forward or reload.");
          const tabId = tabOf(args) ?? control.currentTabId(thread ?? "default");
          if (tabId === undefined) throw new Error("No Chrome tab selected. Call chrome_open first.");
          if (url) await control.ensureOriginAllowed(thread ?? "default", url, "navigate", tabId);
          return await control.withPage(
            thread,
            tabId,
            "navigate",
            async (page) => {
              const result = url ? await page.navigate(url) : nav === "reload" ? await page.reload() : await page.history(nav === "back" ? "back" : "forward");
              await control.verifyLanded(thread, tabId, page);
              return result;
            },
            { checkCurrentOrigin: nav === "reload", ...(ctx.signal ? { signal: ctx.signal } : {}) },
          );
        }),
    },
    {
      name: "chrome_snapshot",
      description:
        "Read the current tab as an accessibility outline with element refs ([ref=e12]). Call before interacting and after the page changes. Use `query` to filter to matching elements, or `ref` to read one subtree. Refs stay valid while the element exists.",
      tier: "read",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Only show elements whose text matches (case-insensitive), with their parents." },
          ref: refProp,
          ...tabIdProp,
        },
      },
      summarize: (args) => (args.query ? `snapshot "${String(args.query)}"` : "snapshot"),
      execute: (args, ctx) =>
        guard(() =>
          control.withPage(threadOf(ctx), tabOf(args), "read", (page) => page.snapshot({ ...(str(args.ref) ? { ref: str(args.ref) as string } : {}), ...(str(args.query) ? { query: str(args.query) as string } : {}) }), {
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        ),
    },
    {
      name: "chrome_click",
      description: "Click an element by ref (or at x,y viewport coordinates). Uses real mouse events. Supports right/middle button, double click and modifiers.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          ref: refProp,
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", enum: ["left", "right", "middle"] },
          double: { type: "boolean" },
          modifiers: { type: "array", items: { type: "string", enum: [...MODIFIERS] } },
          ...tabIdProp,
        },
      },
      summarize: (args) => `click ${String(args.ref ?? `${String(args.x)},${String(args.y)}`)}`,
      execute: action("click"),
    },
    {
      name: "chrome_hover",
      description: "Move the pointer over an element by ref (or x,y) to reveal menus and tooltips.",
      tier: "execute",
      parameters: { type: "object", properties: { ref: refProp, x: { type: "number" }, y: { type: "number" }, ...tabIdProp } },
      summarize: (args) => `hover ${String(args.ref ?? `${String(args.x)},${String(args.y)}`)}`,
      execute: action("hover"),
    },
    {
      name: "chrome_type",
      description: "Type text with real key input into the focused element, or into `ref` after focusing it. Appends to existing content; use chrome_fill to replace.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          ref: refProp,
          submit: { type: "boolean", description: "Press Enter afterwards." },
          ...tabIdProp,
        },
        required: ["text"],
      },
      summarize: (args) => `type ${String(args.text ?? "").slice(0, 40)}`,
      execute: action("type"),
    },
    {
      name: "chrome_fill",
      description: "Replace the content of one or more form fields. Give `ref` and `value` for one field, or `fields` for a whole form. `submit` presses Enter after the last field.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          ref: refProp,
          value: { type: "string" },
          fields: {
            type: "array",
            items: { type: "object", properties: { ref: refProp, value: { type: "string" } }, required: ["ref", "value"] },
          },
          submit: { type: "boolean" },
          ...tabIdProp,
        },
      },
      summarize: (args) => (Array.isArray(args.fields) ? `fill ${args.fields.length} fields` : `fill ${String(args.ref ?? "")}`),
      execute: action("fill"),
    },
    {
      name: "chrome_press",
      description: "Press a key or chord in the page: Enter, Escape, Tab, ArrowDown, F5, Control+A, Shift+Tab…",
      tier: "execute",
      parameters: { type: "object", properties: { key: { type: "string" }, ...tabIdProp }, required: ["key"] },
      summarize: (args) => `press ${String(args.key ?? "")}`,
      execute: action("press"),
    },
    {
      name: "chrome_select",
      description: "Choose option(s) in a <select> by value or visible label.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: { ref: refProp, values: { type: "array", items: { type: "string" } }, ...tabIdProp },
        required: ["ref", "values"],
      },
      summarize: (args) => `select ${String(args.ref ?? "")}`,
      execute: action("select"),
    },
    {
      name: "chrome_scroll",
      description: "Scroll the page (or the scrollable element under `ref`). Positive delta_y scrolls down; default 600.",
      tier: "execute",
      parameters: { type: "object", properties: { ref: refProp, delta_x: { type: "number" }, delta_y: { type: "number" }, ...tabIdProp } },
      summarize: (args) => `scroll ${String(args.delta_y ?? 600)}`,
      execute: action("scroll"),
    },
    {
      name: "chrome_drag",
      description: "Drag from one element (from_ref) or point (from_x, from_y) to another (to_ref or to_x, to_y).",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          from_ref: refProp,
          from_x: { type: "number" },
          from_y: { type: "number" },
          to_ref: refProp,
          to_x: { type: "number" },
          to_y: { type: "number" },
          ...tabIdProp,
        },
      },
      summarize: (args) => `drag ${String(args.from_ref ?? "")} → ${String(args.to_ref ?? "")}`,
      execute: action("drag"),
    },
    {
      name: "chrome_wait",
      description: "Wait for text to appear (`text`) or disappear (`text_gone`) on the page, or just sleep `ms`.",
      tier: "read",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          text_gone: { type: "string" },
          ms: { type: "number", description: "Plain delay in milliseconds (max 30000)." },
          timeout_ms: { type: "number", description: "Give up waiting for text after this long (default 15000)." },
          ...tabIdProp,
        },
      },
      summarize: (args) => (args.text ? `wait for "${String(args.text)}"` : args.text_gone ? `wait until gone "${String(args.text_gone)}"` : `wait ${String(args.ms ?? 1000)}ms`),
      execute: action("wait"),
    },
    {
      name: "chrome_batch",
      description:
        "Run several interactions in order in one call (stops at the first error). Each step is { type: click|hover|type|fill|press|select|scroll|drag|wait, ...that tool's arguments }. Refs come from the latest chrome_snapshot, so batch only steps that don't change the page structure in between.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          steps: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: [...ACTION_TYPES] } }, required: ["type"] } },
          ...tabIdProp,
        },
        required: ["steps"],
      },
      summarize: (args) => `batch of ${Array.isArray(args.steps) ? args.steps.length : 0} steps`,
      execute: (args, ctx) =>
        guard(() =>
          control.withPage(
            threadOf(ctx),
            tabOf(args),
            "batch",
            async (page, tab) => {
              const steps = Array.isArray(args.steps) ? (args.steps as Args[]) : [];
              if (steps.length === 0) throw new Error("steps is required.");
              if (steps.length > MAX_BATCH_STEPS) throw new Error(`At most ${MAX_BATCH_STEPS} steps per batch.`);
              const out: string[] = [];
              for (const [i, step] of steps.entries()) {
                if (ctx.signal?.aborted) throw new Error("Cancelled.");
                const type = ACTION_TYPES.find((t) => t === step.type);
                if (!type) throw new Error(`Step ${i + 1}: unknown type ${JSON.stringify(step.type)}.`);
                try {
                  out.push(`${i + 1}. ${await perform(page, type, step)}`);
                } catch (err) {
                  out.push(`${i + 1}. ERROR: ${err instanceof Error ? err.message : String(err)}`);
                  out.push(`Stopped after step ${i + 1} of ${steps.length}.`);
                  break;
                }
              }
              return out.join("\n") + (await aftermath(page, tab.id, tab.url));
            },
            { ...(ctx.signal ? { signal: ctx.signal } : {}) },
          ),
        ),
    },
    {
      name: "chrome_evaluate",
      description: "Run a JavaScript expression in the page and return its JSON value. Use only when the snapshot and interaction tools can't do it.",
      tier: "execute",
      parameters: { type: "object", properties: { expression: { type: "string" }, ...tabIdProp }, required: ["expression"] },
      summarize: (args) => `evaluate ${String(args.expression ?? "").slice(0, 60)}`,
      execute: (args, ctx) =>
        guard(() => {
          const expression = str(args.expression);
          if (!expression) throw new Error("expression is required.");
          return control.withPage(threadOf(ctx), tabOf(args), "evaluate", (page) => page.evaluate(expression), { ...(ctx.signal ? { signal: ctx.signal } : {}) });
        }),
    },
    {
      name: "chrome_screenshot",
      description: "Capture the current tab (or one element by ref) as a PNG and get an inline-image directive to show it to the user. Use chrome_snapshot to READ a page; screenshots are for the user.",
      tier: "read",
      parameters: {
        type: "object",
        properties: { ref: refProp, full_page: { type: "boolean" }, ...tabIdProp },
      },
      summarize: () => "screenshot",
      execute: (args, ctx) =>
        guard(() =>
          control.withPage(
            threadOf(ctx),
            tabOf(args),
            "screenshot",
            async (page) => {
              const shot = await page.screenshot({
                ...(str(args.ref) ? { ref: str(args.ref) as string } : {}),
                ...(args.full_page === true ? { fullPage: true } : {}),
              });
              const stored = control.saveImage(threadOf(ctx), { base64: shot.base64, mediaType: shot.mediaType });
              if (!stored) return `Captured a screenshot (${Math.round((shot.base64.length * 3) / 4 / 1024)} KB) but could not store it for display.`;
              return `\n::deyin-inline-image{file="${stored}" alt="Chrome screenshot"}\nPut the directive line above in your reply to embed this screenshot.`;
            },
            { ...(ctx.signal ? { signal: ctx.signal } : {}) },
          ),
        ),
    },
    {
      name: "chrome_logs",
      description: "Recent console messages or network responses/failures from the current tab (captured since the tab was first used).",
      tier: "read",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["console", "network"] },
          lines: { type: "number", description: "Lines from the end (default 40)." },
          level: { type: "string", description: "Console only: log, info, warn, error." },
          failed_only: { type: "boolean", description: "Network only: failures and 4xx/5xx." },
          ...tabIdProp,
        },
        required: ["kind"],
      },
      summarize: (args) => `${String(args.kind ?? "console")} logs`,
      execute: (args, ctx) =>
        guard(() =>
          control.withPage(
            threadOf(ctx),
            tabOf(args),
            "read",
            async (page) => {
              const lines = num(args.lines) ?? 40;
              if (args.kind === "network") return page.networkTail(lines, args.failed_only === true);
              if (args.kind === "console") return page.consoleTail(lines, str(args.level));
              throw new Error("kind must be console or network.");
            },
            { ...(ctx.signal ? { signal: ctx.signal } : {}) },
          ),
        ),
    },
    {
      name: "chrome_dialog",
      description: "Accept or dismiss an open alert/confirm/prompt dialog. While a dialog is open other chrome_* calls on that tab fail.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: { accept: { type: "boolean", description: "Default true." }, text: { type: "string", description: "Answer for a prompt." }, ...tabIdProp },
      },
      summarize: (args) => (args.accept === false ? "dismiss dialog" : "accept dialog"),
      execute: (args, ctx) =>
        guard(() =>
          control.withPage(threadOf(ctx), tabOf(args), "dialog", (page) => page.handleDialog(args.accept !== false, str(args.text)), {
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            checkCurrentOrigin: false,
          }),
        ),
    },
  ];
}
