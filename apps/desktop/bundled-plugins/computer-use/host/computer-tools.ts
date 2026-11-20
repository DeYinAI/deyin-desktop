import type { ToolContext, ToolDefinition } from "@deyin/agent-core";
import {
  HostCancelledError,
  HostRpcError,
  RPC_CODES,
  type ActionMethod,
  type ActionResult,
  type ComputerUseHostApi,
  type Target,
  type WindowInfo,
} from "@deyin/computer-use-host";
import { ComputerUseSession, ComputerUseStoppedError } from "./computer-session.js";
import {
  formatAction,
  formatApps,
  formatDisplays,
  formatLaunch,
  formatWindowState,
  formatWindows,
} from "./computer-format.js";

/**
 * `computer_*` agent tools: drive Windows apps. Quiet methods (window messages, UI Automation) run first, so the
 * user's mouse, keyboard and focus are left alone; the real mouse and keyboard are used only when nothing quieter
 * works, and the host puts the pointer and the foreground window back afterwards.
 */

export interface ComputerToolsDeps {
  session: ComputerUseSession;
  /** The host, with this action's cancellation attached. */
  host(signal?: AbortSignal): ComputerUseHostApi;
  /** Throws unless the app owning this window may be driven (asks the user when it is not on the allowlist). */
  authorizeWindow(windowId: string): Promise<WindowInfo>;
  authorizeApp(appId: string, action: string): Promise<void>;
  /** How often computer_wait looks again (default 500 ms); tests shorten it. */
  pollMs?: number;
}

type Args = Record<string, unknown>;

const METHODS = ["auto", "uia", "msg", "input"] as const;
const BUTTONS = ["left", "right", "middle"] as const;
type Button = (typeof BUTTONS)[number];

const MAX_WAIT_SECONDS = 30;
const DEFAULT_WAIT_POLL_MS = 500;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const int = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.trunc(n);
};

function requireStr(args: Args, key: string): string {
  const value = str(args[key]);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

/** Drop undefined entries, so optional fields are absent rather than `undefined`. */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) if (value !== undefined) out[key] = value;
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function methodOf(args: Args): ActionMethod | undefined {
  const value = str(args.method);
  if (!value) return undefined;
  if (!(METHODS as readonly string[]).includes(value)) {
    throw new Error(`method must be one of ${METHODS.join(", ")}.`);
  }
  return value as ActionMethod;
}

function buttonOf(args: Args): Button | undefined {
  const value = str(args.button);
  if (!value) return undefined;
  if (!(BUTTONS as readonly string[]).includes(value)) throw new Error(`button must be one of ${BUTTONS.join(", ")}.`);
  return value as Button;
}

function modifiersOf(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((m): m is string => typeof m === "string" && m.length > 0);
  return out.length ? out : undefined;
}

/** A ref from computer_get_state, or x and y in screenshot pixels. */
function targetOf(args: Args, prefix = ""): Target {
  const ref = str(args[`${prefix}ref`]);
  if (ref) return { ref };
  const x = num(args[`${prefix}x`]);
  const y = num(args[`${prefix}y`]);
  if (x !== undefined && y !== undefined) return { x, y };
  throw new Error(`Provide ${prefix}ref (from computer_get_state) or both ${prefix}x and ${prefix}y.`);
}

function optionalTargetOf(args: Args): Target | undefined {
  if (str(args.ref) || (num(args.x) !== undefined && num(args.y) !== undefined)) return targetOf(args);
  return undefined;
}

function describeTarget(t: Target | undefined): string {
  if (!t) return "the window";
  return t.ref ?? `(${t.x}, ${t.y})`;
}

/** Turn host and session failures into messages that tell the model what to do next. */
export function translateError(err: unknown): Error {
  if (err instanceof ComputerUseStoppedError || err instanceof HostCancelledError) {
    return new Error("Computer use was stopped by the user. Do not retry on your own; ask how they want to continue.");
  }
  if (err instanceof HostRpcError) {
    if (err.code === RPC_CODES.tookOver) {
      return new Error(
        "The user took over the mouse or keyboard, so this action was abandoned. Computer use is paused until they resume it. When you can act again, call computer_get_state before doing anything else.",
      );
    }
    if (err.code === RPC_CODES.timedOut) {
      return new Error(
        `${err.message} The app may be busy or showing a dialog; call computer_list_windows, then computer_get_state.`,
      );
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ComputerUseStoppedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ComputerUseStoppedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const targetProps = {
  ref: { type: "string", description: "Element ref from the latest computer_get_state." },
  x: { type: "number", description: "X in screenshot pixels, measured from the window's left edge. Use with y instead of ref." },
  y: { type: "number", description: "Y in screenshot pixels, measured from the window's top edge." },
};

const methodProp = {
  type: "string",
  enum: [...METHODS],
  description:
    "auto (default) tries the quietest way first: window messages, then UI Automation, then the real mouse/keyboard. uia and msg never touch the user's mouse or focus and fail instead of falling back; input forces the real mouse/keyboard.",
};

export function createComputerUseTools(deps: ComputerToolsDeps): ToolDefinition[] {
  /** Run one action in a window the user allowed, with the overlay, Stop and takeover handling around it. */
  const inWindow = async (
    args: Args,
    ctx: ToolContext,
    action: string,
    run: (host: ComputerUseHostApi, window: WindowInfo, signal: AbortSignal) => Promise<string>,
  ): Promise<string> => {
    const window = await deps.authorizeWindow(requireStr(args, "window_id"));
    try {
      return await deps.session.run(
        { app: window.app, action },
        (signal) => run(deps.host(signal), window, signal),
        ctx.signal,
      );
    } catch (err) {
      if (err instanceof HostRpcError && err.code === RPC_CODES.tookOver) deps.session.pause();
      throw translateError(err);
    }
  };

  /** An action tool: authorize the window, run `call`, and report how it was done. */
  const acting =
    (
      what: (args: Args) => string,
      call: (host: ComputerUseHostApi, window: WindowInfo, args: Args) => Promise<ActionResult>,
    ) =>
    // async, so a bad argument is a rejected promise like every other failure, never a synchronous throw
    async (args: Args, ctx: ToolContext): Promise<string> => {
      const label = what(args);
      return inWindow(args, ctx, label, async (host, window) => formatAction(await call(host, window, args), label));
    };

  const windowIdProp = { type: "string", description: "Window id from computer_list_windows or computer_launch_app." };

  return [
    {
      name: "computer_list_apps",
      description: "List installed applications that can be launched with computer_launch_app.",
      tier: "read",
      parameters: { type: "object", properties: {} },
      summarize: () => "list apps",
      execute: async (_args, ctx) => {
        try {
          return formatApps(await deps.host(ctx.signal).listApps());
        } catch (err) {
          throw translateError(err);
        }
      },
    },
    {
      name: "computer_list_windows",
      description:
        "List open windows with ids, app, title, size and position (screen pixels). Use the id with the other computer_* tools.",
      tier: "read",
      parameters: { type: "object", properties: {} },
      summarize: () => "list windows",
      execute: async (_args, ctx) => {
        try {
          return formatWindows(await deps.host(ctx.signal).listWindows());
        } catch (err) {
          throw translateError(err);
        }
      },
    },
    {
      name: "computer_list_displays",
      description: "List the monitors with their position, size and scale. Screen coordinates span all of them.",
      tier: "read",
      parameters: { type: "object", properties: {} },
      summarize: () => "list displays",
      execute: async (_args, ctx) => {
        try {
          return formatDisplays(await deps.host(ctx.signal).listDisplays());
        } catch (err) {
          throw translateError(err);
        }
      },
    },
    {
      name: "computer_get_state",
      description:
        "Observe a window without touching it: where it is, a screenshot file, and an outline of its UI elements with refs. Call before acting and after any action that changes the UI; refs only work for the observation that produced them. Use query to find an element by its text (cheaper than the whole tree) and depth to read less. If the elements are unavailable (for example the app is inside a modal dialog), list the windows and observe the dialog's own window.",
      tier: "read",
      parameters: {
        type: "object",
        properties: {
          window_id: windowIdProp,
          screenshot: { type: "boolean", description: "Capture a screenshot file (default true)." },
          tree: { type: "boolean", description: "Include the UI element outline (default true)." },
          depth: { type: "integer", description: "Only descend this many levels of the element tree." },
          query: {
            type: "string",
            description: "Only elements whose name, value, id or role contains this text (case-insensitive), with their parents.",
          },
          max_nodes: { type: "integer", description: "Cap on elements returned (default 500)." },
        },
        required: ["window_id"],
      },
      summarize: (args) => `observe ${String(args.window_id ?? "")}${args.query ? ` for "${String(args.query)}"` : ""}`,
      execute: (args, ctx) =>
        inWindow(args, ctx, "observe", async (host, w) =>
          formatWindowState(
            await host.getWindowState(
              w.id,
              compact({
                screenshot: args.screenshot !== false,
                tree: args.tree !== false,
                depth: int(args.depth),
                query: str(args.query),
                maxNodes: int(args.max_nodes),
              }),
            ),
          ),
        ),
    },
    {
      name: "computer_launch_app",
      description: "Launch an application by id or executable name and return its window.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: { app_id: { type: "string", description: "App id from computer_list_apps, or an executable name." } },
        required: ["app_id"],
      },
      summarize: (args) => `launch ${String(args.app_id ?? "")}`,
      execute: async (args, ctx) => {
        const appId = requireStr(args, "app_id");
        await deps.authorizeApp(appId, "launch");
        try {
          return await deps.session.run(
            { app: appId.replace(/\.exe$/i, ""), action: `launch ${appId}` },
            async (signal) => formatLaunch(await deps.host(signal).launchApp(appId)),
            ctx.signal,
          );
        } catch (err) {
          throw translateError(err);
        }
      },
    },
    {
      name: "computer_click",
      description:
        "Click an element (ref) or a point (x, y in screenshot pixels). Quiet methods run first, so the user's mouse and focus are normally left alone; the result says which method was used. Set count 2 for a double-click, button right for a context menu, and modifiers (for example [\"ctrl\"]) for ctrl-click or shift-click.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          window_id: windowIdProp,
          ...targetProps,
          button: { type: "string", enum: [...BUTTONS], description: "Mouse button (default left)." },
          count: { type: "integer", description: "Number of clicks, 1 to 3 (default 1)." },
          modifiers: { type: "array", items: { type: "string", enum: ["ctrl", "shift", "alt", "win"] }, description: "Keys held during the click." },
          method: methodProp,
        },
        required: ["window_id"],
      },
      summarize: (args) => {
        const target = optionalTargetOf(args);
        const button = str(args.button);
        const count = int(args.count);
        return `${button && button !== "left" ? `${button}-` : ""}${count && count > 1 ? `${count}x ` : ""}click ${describeTarget(target)}`;
      },
      execute: acting(
        (args) => {
          const button = str(args.button);
          return `${button && button !== "left" ? `${button}-click` : "click"} ${describeTarget(targetOf(args))}`;
        },
        (host, w, args) =>
          host.click(
            w.id,
            {
              ...targetOf(args),
              ...compact({ button: buttonOf(args), count: int(args.count), modifiers: modifiersOf(args.modifiers), method: methodOf(args) }),
            },
          ),
      ),
    },
    {
      name: "computer_hover",
      description:
        "Move the pointer over an element (ref) or point (x, y in screenshot pixels) to reveal tooltips or hover menus. This uses the real mouse and leaves the pointer there.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: { window_id: windowIdProp, ...targetProps },
        required: ["window_id"],
      },
      summarize: (args) => `hover ${describeTarget(optionalTargetOf(args))}`,
      execute: acting(
        (args) => `hover ${describeTarget(targetOf(args))}`,
        (host, w, args) => host.hover(w.id, targetOf(args)),
      ),
    },
    {
      name: "computer_type",
      description:
        "Type text. With ref it goes to that field using quiet methods when it can; without ref it types into whatever has focus in the window using the real keyboard. Does not press Enter; use computer_press_key for that.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          window_id: windowIdProp,
          text: { type: "string", description: "Text to type." },
          ref: targetProps.ref,
          method: methodProp,
        },
        required: ["window_id", "text"],
      },
      summarize: (args) => `type ${String(args.text ?? "").slice(0, 40)}`,
      execute: acting(
        (args) => `type ${String(args.text ?? "").slice(0, 24)}${String(args.text ?? "").length > 24 ? "…" : ""}`,
        (host, w, args) => {
          if (typeof args.text !== "string") throw new Error("text is required.");
          return host.typeText(w.id, args.text, compact({ ref: str(args.ref), method: methodOf(args) }));
        },
      ),
    },
    {
      name: "computer_press_key",
      description:
        "Press a key or chord in the window, for example enter, tab, escape, f5, ctrl+a, ctrl+shift+t, alt+left. Uses the real keyboard and briefly brings the window forward, then restores the previous one.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: { window_id: windowIdProp, key: { type: "string", description: "Key name or chord joined with +." } },
        required: ["window_id", "key"],
      },
      summarize: (args) => `press ${String(args.key ?? "")}`,
      execute: acting(
        (args) => `press ${String(args.key ?? "")}`,
        (host, w, args) => host.pressKey(w.id, requireStr(args, "key")),
      ),
    },
    {
      name: "computer_scroll",
      description:
        "Scroll a list, page or document. Give a ref or a point to scroll that element; otherwise the window's center. Positive delta_y scrolls down, positive delta_x scrolls right. Uses UI Automation scrolling when the element supports it, so the user's mouse is left alone.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          window_id: windowIdProp,
          ...targetProps,
          delta_y: { type: "number", description: "Wheel notches/pixels down (default 600 when no delta is given)." },
          delta_x: { type: "number", description: "Horizontal amount." },
          method: methodProp,
        },
        required: ["window_id"],
      },
      summarize: (args) => `scroll ${String(args.delta_y ?? args.delta_x ?? 600)}`,
      execute: acting(
        (args) => `scroll ${describeTarget(optionalTargetOf(args))}`,
        (host, w, args) => {
          const deltaY = int(args.delta_y);
          const deltaX = int(args.delta_x);
          return host.scroll(w.id, {
            ...(optionalTargetOf(args) ?? {}),
            ...compact({
              deltaY: deltaY ?? (deltaX === undefined ? 600 : undefined),
              deltaX,
              method: methodOf(args),
            }),
          });
        },
      ),
    },
    {
      name: "computer_drag",
      description:
        "Drag from one element or point to another with the real mouse (reordering, sliders, selecting text, moving files). Each end is a ref or x/y in screenshot pixels.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: {
          window_id: windowIdProp,
          from_ref: { type: "string" },
          from_x: { type: "number" },
          from_y: { type: "number" },
          to_ref: { type: "string" },
          to_x: { type: "number" },
          to_y: { type: "number" },
        },
        required: ["window_id"],
      },
      summarize: (args) => {
        const from = str(args.from_ref) ?? `(${String(args.from_x ?? "?")}, ${String(args.from_y ?? "?")})`;
        const to = str(args.to_ref) ?? `(${String(args.to_x ?? "?")}, ${String(args.to_y ?? "?")})`;
        return `drag ${from} → ${to}`;
      },
      execute: acting(
        (args) => `drag ${describeTarget(targetOf(args, "from_"))} → ${describeTarget(targetOf(args, "to_"))}`,
        (host, w, args) => host.drag(w.id, targetOf(args, "from_"), targetOf(args, "to_")),
      ),
    },
    {
      name: "computer_set_value",
      description:
        "Replace the contents of a text field by ref. Uses the field's value pattern or window messages, so nothing is typed with the real keyboard when the field supports it; otherwise it selects all and types.",
      tier: "execute",
      parameters: {
        type: "object",
        properties: { window_id: windowIdProp, ref: targetProps.ref, value: { type: "string" } },
        required: ["window_id", "ref", "value"],
      },
      summarize: (args) => `set value ${String(args.ref ?? "")}`,
      execute: acting(
        (args) => `set value ${String(args.ref ?? "")}`,
        (host, w, args) => {
          if (typeof args.value !== "string") throw new Error("value is required.");
          return host.setValue(w.id, requireStr(args, "ref"), args.value);
        },
      ),
    },
    {
      name: "computer_wait",
      description:
        "Wait for the app to settle. With seconds, just pause (up to 30). With window_id and text, poll until an element containing that text appears (up to timeout_seconds) and return it with its ref.",
      tier: "read",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "How long to pause (default 1, max 30). Ignored when text is given." },
          window_id: { type: "string", description: "Window to watch; required with text." },
          text: { type: "string", description: "Wait until an element whose name, value or id contains this appears." },
          timeout_seconds: { type: "number", description: "Give up after this long when waiting for text (default 10, max 30)." },
        },
      },
      summarize: (args) => (args.text ? `wait for "${String(args.text)}"` : `wait ${String(args.seconds ?? 1)}s`),
      execute: async (args, ctx) => {
        const text = str(args.text);
        if (!text) {
          const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, num(args.seconds) ?? 1));
          try {
            await deps.session.run({ action: "wait" }, (signal) => sleep(seconds * 1000, signal), ctx.signal);
          } catch (err) {
            throw translateError(err);
          }
          return `Waited ${seconds}s.`;
        }
        const timeout = Math.min(MAX_WAIT_SECONDS, Math.max(1, num(args.timeout_seconds) ?? 10));
        const needle = text.toLowerCase();
        return inWindow(args, ctx, `wait for "${text}"`, async (host, w, signal) => {
          const deadline = Date.now() + timeout * 1000;
          for (;;) {
            const state = await host.getWindowState(w.id, { screenshot: false, tree: true, query: text, maxNodes: 25 });
            const hit = state.tree?.nodes.some((n) =>
              [n.name, n.value, n.id].some((field) => field?.toLowerCase().includes(needle)),
            );
            if (hit) return formatWindowState(state);
            if (Date.now() >= deadline) return `Timed out after ${timeout}s waiting for "${text}" in ${w.app} "${w.title}".`;
            await sleep(deps.pollMs ?? DEFAULT_WAIT_POLL_MS, signal);
          }
        });
      },
    },
  ];
}
