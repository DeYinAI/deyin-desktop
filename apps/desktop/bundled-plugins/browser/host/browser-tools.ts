import type { ToolDefinition } from "@deyin/agent-core";
import type { CdpPage } from "./cdp-page.js";

/**
 * What the agent tools need from the in-app browser. The Electron side
 * (BrowserControlService) implements this; keeping the tools behind an
 * interface lets them run against a fake page in tests.
 */
export interface BrowserToolHost {
  /** Run `fn` on the current tab's page. The host picks the tab and shows the activity indicator. */
  withPage<T>(fn: (page: CdpPage) => Promise<T>): Promise<T>;
  navigate(url: string): Promise<string>;
  screenshot(threadId?: string): Promise<string>;
  manageTabs(action: TabAction, url?: string, tabId?: number): Promise<string>;
}

export type TabAction = "list" | "open" | "switch" | "close";

const TAB_ACTIONS: readonly TabAction[] = ["list", "open", "switch", "close"];

/** Refs from browser_snapshot look like e12. Anything else is rejected before it reaches the page. */
const REF_PATTERN = /^e\d+$/;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * An element named either by a snapshot ref or by a CSS selector, resolved to
 * a ref so every action takes the same trusted-input path.
 */
async function resolveRef(page: CdpPage, ref: unknown, selector: unknown, what = "element"): Promise<{ ref: string; selector?: string }> {
  const r = text(ref);
  if (r) {
    if (!REF_PATTERN.test(r)) throw new Error(`Invalid browser ref: ${r}`);
    return { ref: r };
  }
  const s = text(selector);
  if (s) return { ref: await page.refForSelector(s), selector: s };
  throw new Error(`Provide a ref (from browser_snapshot) or a CSS selector for the ${what}.`);
}

const refProp = { type: "string", description: "Element ref from browser_snapshot (e.g. e12)." };
const selectorProp = { type: "string", description: "CSS selector, when you have no ref." };

export function createBrowserTools(host: BrowserToolHost): ToolDefinition[] {
  // Tool failures are results the model can read, never exceptions. `await` inside the try
  // also covers a callback that throws before it returns a promise.
  const wrap = async (fn: () => Promise<string>): Promise<string> => {
    try {
      return await fn();
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  return [
    {
      name: "browser_navigate",
      description: "Open a URL in the built-in workspace browser tab.",
      tier: "execute",
      parameters: { type: "object", properties: { url: { type: "string", description: "URL to open." } }, required: ["url"] },
      summarize: (args) => String(args.url ?? ""),
      execute: (args) => wrap(() => host.navigate(String(args.url ?? ""))),
    },
    {
      name: "browser_click",
      description: "Click an element by ref from browser_snapshot, or by CSS selector. Uses real mouse input.",
      tier: "execute",
      parameters: { type: "object", properties: { ref: refProp, selector: selectorProp } },
      summarize: (args) => String(args.ref ?? args.selector ?? ""),
      execute: (args) =>
        wrap(() =>
          host.withPage(async (page) => {
            const target = await resolveRef(page, args.ref, args.selector);
            const out = await page.click({ ref: target.ref });
            return target.selector ? `${out} (${target.selector})` : out;
          }),
        ),
    },
    {
      name: "browser_type",
      description: "Type text into the focused element, or into the element named by ref/selector (focused first).",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type." },
          ref: refProp,
          selector: { type: "string", description: "Optional CSS selector to focus first." },
        },
        required: ["text"],
      },
      summarize: (args) => `type ${String(args.text ?? "").slice(0, 40)}`,
      execute: (args) =>
        wrap(() =>
          host.withPage(async (page) => {
            const named = text(args.ref) || text(args.selector);
            const target = named ? await resolveRef(page, args.ref, args.selector) : undefined;
            return page.type(String(args.text ?? ""), target?.ref);
          }),
        ),
    },
    {
      name: "browser_press",
      description: "Press a key or chord in the browser tab: Enter, Tab, Escape, ArrowDown, PageDown, Control+A, Shift+Tab…",
      tier: "execute",
      parameters: { type: "object", properties: { key: { type: "string", description: "Key or chord, e.g. Enter or Control+A." } }, required: ["key"] },
      summarize: (args) => `press ${String(args.key ?? "")}`,
      execute: (args) => wrap(() => host.withPage((page) => page.press(String(args.key ?? "")))),
    },
    {
      name: "browser_scroll",
      description: "Scroll the page vertically by a pixel delta (negative = up).",
      tier: "execute",
      parameters: { type: "object", properties: { delta_y: { type: "number", description: "Pixels to scroll (default 600)." } } },
      summarize: (args) => `scroll ${String(args.delta_y ?? 600)}`,
      execute: (args) => wrap(() => host.withPage((page) => page.scroll({ deltaY: Number(args.delta_y) || 600 }))),
    },
    {
      name: "browser_snapshot",
      description:
        "Accessibility snapshot of the current page: headings, links, buttons and fields with element refs like [ref=e12]. Call it before clicking or typing, and again after the page changes. Use `query` to find one control on a large page.",
      tier: "read",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Only show elements whose text matches (case-insensitive), with their parents." },
          ref: { type: "string", description: "Read one subtree instead of the whole page." },
        },
      },
      summarize: (args) => (args.query ? `snapshot "${String(args.query)}"` : "snapshot"),
      execute: (args) =>
        wrap(() =>
          host.withPage((page) => {
            const ref = text(args.ref);
            if (ref && !REF_PATTERN.test(ref)) throw new Error(`Invalid browser ref: ${ref}`);
            const query = text(args.query);
            return page.snapshot({ ...(ref ? { ref } : {}), ...(query ? { query } : {}) });
          }),
        ),
    },
    {
      name: "browser_screenshot",
      description: "Capture the browser tab to a PNG file and get an inline-image directive to embed it.",
      tier: "read",
      parameters: { type: "object", properties: {} },
      summarize: () => "screenshot",
      execute: (_args, ctx) => wrap(() => host.screenshot(ctx?.sessionMeta?.threadId)),
    },
    {
      name: "browser_console",
      description: "Recent console messages from the current tab. Ask for only the lines you need.",
      tier: "read",
      parameters: { type: "object", properties: { lines: { type: "number", description: "Lines from the end (default 40)." } } },
      summarize: () => "console tail",
      execute: (args) => wrap(() => host.withPage(async (page) => page.consoleTail(Number(args.lines) || 40))),
    },
    {
      name: "browser_network",
      description: "Recent network responses and failures from the current tab.",
      tier: "read",
      parameters: { type: "object", properties: { lines: { type: "number", description: "Lines from the end (default 40)." } } },
      summarize: () => "network tail",
      execute: (args) => wrap(() => host.withPage(async (page) => page.networkTail(Number(args.lines) || 40))),
    },
    {
      name: "browser_tabs",
      description: "List, open, switch, or close browser tabs.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...TAB_ACTIONS] },
          url: { type: "string" },
          tab_id: { type: "number" },
        },
        required: ["action"],
      },
      summarize: (args) => `tabs ${String(args.action ?? "")}`,
      execute: (args) =>
        wrap(async () => {
          const action = TAB_ACTIONS.find((a) => a === args.action);
          if (!action) throw new Error(`action must be one of: ${TAB_ACTIONS.join(", ")}.`);
          return host.manageTabs(action, text(args.url), args.tab_id !== undefined ? Number(args.tab_id) : undefined);
        }),
    },
    {
      name: "browser_fill",
      description: "Fill a form field by ref or CSS selector (replaces the existing value, firing real input events).",
      tier: "execute",
      parameters: {
        type: "object",
        properties: { ref: refProp, selector: selectorProp, value: { type: "string" } },
        required: ["value"],
      },
      summarize: (args) => `fill ${String(args.ref ?? args.selector ?? "")}`,
      execute: (args) =>
        wrap(() =>
          host.withPage(async (page) => {
            const target = await resolveRef(page, args.ref, args.selector, "field");
            return page.fill(target.ref, String(args.value ?? ""));
          }),
        ),
    },
    {
      name: "browser_fill_form",
      description: "Fill multiple form fields at once. Each field names an element by ref or CSS selector.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: { type: "object", properties: { ref: refProp, selector: selectorProp, value: { type: "string" } }, required: ["value"] },
          },
        },
        required: ["fields"],
      },
      summarize: () => "fill form",
      execute: (args) =>
        wrap(() =>
          host.withPage(async (page) => {
            const fields = Array.isArray(args.fields) ? (args.fields as Array<Record<string, unknown>>) : [];
            const results: string[] = [];
            for (const field of fields) {
              const label = text(field.ref) ?? text(field.selector) ?? "(unnamed)";
              try {
                const target = await resolveRef(page, field.ref, field.selector, "field");
                await page.fill(target.ref, String(field.value ?? ""));
                results.push(`OK ${label}`);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                results.push(/no element matches/.test(message) ? `MISS ${label}` : `ERROR ${label}: ${message}`);
              }
            }
            return results.join("\n");
          }),
        ),
    },
    {
      name: "browser_hover",
      description: "Hover over an element by ref or CSS selector.",
      tier: "execute",
      parameters: { type: "object", properties: { ref: refProp, selector: selectorProp } },
      summarize: (args) => `hover ${String(args.ref ?? args.selector ?? "")}`,
      execute: (args) =>
        wrap(() =>
          host.withPage(async (page) => {
            const target = await resolveRef(page, args.ref, args.selector);
            return page.hover({ ref: target.ref });
          }),
        ),
    },
    {
      name: "browser_drag",
      description: "Drag from one element to another (each by ref or CSS selector) with real mouse input.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          from_ref: refProp,
          from_selector: { type: "string", description: "CSS selector of the element to drag." },
          to_ref: refProp,
          to_selector: { type: "string", description: "CSS selector of the drop target." },
        },
      },
      summarize: (args) => `drag ${String(args.from_ref ?? args.from_selector ?? "")}`,
      execute: (args) =>
        wrap(() =>
          host.withPage(async (page) => {
            const from = await resolveRef(page, args.from_ref, args.from_selector, "drag source");
            const to = await resolveRef(page, args.to_ref, args.to_selector, "drop target");
            return page.drag({ ref: from.ref }, { ref: to.ref });
          }),
        ),
    },
    {
      name: "browser_handle_dialog",
      description: "Accept or dismiss the open JavaScript dialog (alert/confirm/prompt). A dialog blocks the page until you do.",
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
        wrap(() =>
          host.withPage((page) => {
            // A prompt accepted with no text keeps the page's own default, as it would for a user pressing OK.
            const promptText = typeof args.prompt_text === "string" ? args.prompt_text : page.pendingDialog()?.defaultPrompt;
            return page.handleDialog(Boolean(args.accept), promptText);
          }),
        ),
    },
  ];
}
