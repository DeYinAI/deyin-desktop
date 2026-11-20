import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

/** A rectangle in physical screen pixels (window bounds) or screenshot pixels (node bounds). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppInfo {
  id: string;
  name: string;
  path: string;
}

export interface WindowInfo {
  id: string;
  title: string;
  /** Process name, lowercase-insensitive (for example `notepad`). Permission decisions use this. */
  app: string;
  pid: number;
  /** Visible frame in physical screen pixels. */
  bounds: Rect;
  displayId?: string | null;
  /** Display scale factor: 1.5 means 150%. */
  dpiScale: number;
  minimized: boolean;
  foreground: boolean;
  /** The app runs as administrator; ordinary input cannot reach it. */
  elevated: boolean;
}

export interface DisplayInfo {
  id: string;
  name: string;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  workX: number;
  workY: number;
  workWidth: number;
  workHeight: number;
  dpi: number;
  scale: number;
}

export interface UiNode {
  /** Use this in `ref` arguments. Includes the observation id, so a stale ref is rejected instead of misclicking. */
  ref: string;
  role: string;
  name: string;
  value?: string;
  /** In screenshot pixels, relative to the window: the same space as `x`/`y` arguments. */
  bounds: Rect;
  depth: number;
  enabled?: boolean;
  focused?: boolean;
  toggled?: string;
  expanded?: string;
  selected?: boolean;
  id?: string;
  password?: boolean;
}

export interface ScreenshotInfo {
  /** Absent when the window is minimized or could not be captured; see `note`. */
  path?: string | null;
  width: number;
  height: number;
  /** Screenshot pixels per physical screen pixel (1 unless the window is very large). */
  scale: number;
  method: string;
  note?: string | null;
}

export interface TreeInfo {
  stateId: number;
  nodes: UiNode[];
  visited: number;
  truncated: boolean;
  note?: string | null;
}

export interface WindowState {
  window: WindowInfo;
  screenshot?: ScreenshotInfo | null;
  tree?: TreeInfo | null;
  /** Why the tree is missing when it was asked for (for example the app is inside a modal dialog). */
  treeError?: string | null;
}

export interface StateOptions {
  screenshot?: boolean;
  tree?: boolean;
  /** Only descend this many levels. */
  depth?: number;
  /** Keep elements whose name, value, id or role contains this text (case-insensitive), with their parents. */
  query?: string;
  maxNodes?: number;
}

/** What to act on: an element (`ref`) or a point (`x`, `y`) in screenshot pixels. */
export interface Target {
  ref?: string;
  x?: number;
  y?: number;
}

/**
 * `auto` tries the quietest mechanism that works. `uia` and `msg` never touch focus or the cursor;
 * `input` uses the real mouse and keyboard.
 */
export type ActionMethod = "auto" | "uia" | "msg" | "input";

export interface ClickOptions extends Target {
  button?: "left" | "right" | "middle";
  count?: number;
  modifiers?: string[];
  method?: ActionMethod;
}

export interface ScrollOptions extends Target {
  deltaX?: number;
  deltaY?: number;
  method?: ActionMethod;
}

export interface ActionResult {
  ok: boolean;
  /** What actually performed the action. */
  method: "uia" | "msg" | "input";
  detail?: string | null;
  /** True when the real cursor was moved (and put back, except for hover). */
  cursorMoved?: boolean | null;
  /** True when keyboard focus or the foreground window was changed (and restored when possible). */
  focusChanged?: boolean | null;
}

export interface LaunchResult {
  launched: string;
  /** Empty when no window appeared in time. */
  windowId: string;
  pid: number;
  window?: WindowInfo | null;
}

export interface HostInfo {
  ok: boolean;
  version: number;
  dpiAwareness: string;
  elevated: boolean;
  virtualDesktop: Rect;
  /** Where the real mouse pointer is, in physical screen pixels. */
  cursor: { x: number; y: number };
  /** Id of the window that currently has the keyboard. */
  foreground: string;
}

/** Something the host reports on its own, such as the user grabbing the mouse mid-action. */
export interface HostEvent {
  type: string;
  data?: unknown;
}

export interface ComputerUseHostApi {
  ping(): Promise<boolean>;
  info?(): Promise<HostInfo>;
  listApps(): Promise<AppInfo[]>;
  listWindows(): Promise<WindowInfo[]>;
  getWindow(windowId: string): Promise<WindowInfo>;
  listDisplays(): Promise<DisplayInfo[]>;
  getWindowState(windowId: string, opts?: StateOptions): Promise<WindowState>;
  launchApp(appId: string): Promise<LaunchResult>;
  click(windowId: string, opts: ClickOptions): Promise<ActionResult>;
  hover(windowId: string, target: Target): Promise<ActionResult>;
  typeText(windowId: string, text: string, opts?: { ref?: string; method?: ActionMethod }): Promise<ActionResult>;
  pressKey(windowId: string, key: string): Promise<ActionResult>;
  scroll(windowId: string, opts: ScrollOptions): Promise<ActionResult>;
  drag(windowId: string, from: Target, to: Target): Promise<ActionResult>;
  setValue(windowId: string, ref: string, value: string): Promise<ActionResult>;
  /** Stop whatever is running now. Safe to call when nothing is. */
  cancel?(): Promise<void>;
  /** Subscribe to host events. Returns an unsubscribe function. */
  onEvent?(handler: (event: HostEvent) => void): () => void;
  dispose?(): void;
}

const MOCK_WINDOW: WindowInfo = {
  id: "win-1",
  title: "Mock Window",
  app: "notepad",
  pid: 1,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  displayId: "1",
  dpiScale: 1,
  minimized: false,
  foreground: true,
  elevated: false,
};

const MOCK_OK: ActionResult = { ok: true, method: "uia", detail: "mock", cursorMoved: false, focusChanged: false };

/** In-process mock host for dev/tests on non-Windows platforms. */
export class MockComputerUseHost implements ComputerUseHostApi {
  async ping() {
    return true;
  }
  async listApps(): Promise<AppInfo[]> {
    return [{ id: "notepad", name: "Notepad", path: "notepad.exe" }];
  }
  async listWindows(): Promise<WindowInfo[]> {
    return [MOCK_WINDOW];
  }
  async getWindow(): Promise<WindowInfo> {
    return MOCK_WINDOW;
  }
  async listDisplays(): Promise<DisplayInfo[]> {
    return [
      { id: "1", name: "\\\\.\\DISPLAY1", primary: true, x: 0, y: 0, width: 1920, height: 1080, workX: 0, workY: 0, workWidth: 1920, workHeight: 1040, dpi: 96, scale: 1 },
    ];
  }
  async getWindowState(): Promise<WindowState> {
    return {
      window: MOCK_WINDOW,
      screenshot: { path: null, width: 800, height: 600, scale: 1, method: "mock" },
      tree: {
        stateId: 1,
        visited: 2,
        truncated: false,
        nodes: [
          { ref: "s1e1", role: "Window", name: "Mock Window", bounds: { x: 0, y: 0, width: 800, height: 600 }, depth: 0 },
          { ref: "s1e2", role: "Button", name: "OK", bounds: { x: 10, y: 10, width: 80, height: 24 }, depth: 1 },
        ],
      },
    };
  }
  async launchApp(appId: string): Promise<LaunchResult> {
    return { launched: appId, windowId: "win-1", pid: 1, window: MOCK_WINDOW };
  }
  async click() {
    return MOCK_OK;
  }
  async hover() {
    return MOCK_OK;
  }
  async typeText() {
    return MOCK_OK;
  }
  async pressKey() {
    return MOCK_OK;
  }
  async scroll() {
    return MOCK_OK;
  }
  async drag() {
    return MOCK_OK;
  }
  async setValue() {
    return MOCK_OK;
  }
  async cancel() {}
}

export function parseRpcLine(line: string): JsonRpcResponse | null {
  try {
    return JSON.parse(line) as JsonRpcResponse;
  } catch {
    return null;
  }
}

export function formatRpcRequest(req: JsonRpcRequest): string {
  return `${JSON.stringify(req)}\n`;
}
