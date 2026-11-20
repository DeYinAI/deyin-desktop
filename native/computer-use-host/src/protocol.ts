export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A message the host pushes without being asked (no id): `{ method: "event", params: { type, data } }`. */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: "event";
  params: { type: string; data?: unknown };
}

export const PIPE_NAME = "deyin-computer-use";

export type ComputerUseMethod =
  | "ping"
  | "cancel"
  | "list_apps"
  | "list_windows"
  | "get_window"
  | "list_displays"
  | "get_window_state"
  | "launch_app"
  | "click"
  | "hover"
  | "type_text"
  | "press_key"
  | "scroll"
  | "drag"
  | "set_value"
  | "simulate_takeover";

/** Error codes the host returns that callers may want to treat differently from a plain failure. */
export const RPC_CODES = {
  cancelled: -32800,
  timedOut: -32001,
  busy: -32002,
  notFound: -32004,
  /** The user grabbed the mouse or keyboard while the host was using them; the action was abandoned. */
  tookOver: -32005,
} as const;

/**
 * How long the client waits for each method. A little longer than the host's own deadline for the same method, so
 * the host's more specific error ("did not finish within 20s") arrives first.
 */
export const METHOD_TIMEOUT_MS: Record<ComputerUseMethod, number> = {
  ping: 5_000,
  cancel: 5_000,
  list_apps: 34_000,
  list_windows: 14_000,
  get_window: 8_000,
  list_displays: 8_000,
  get_window_state: 34_000,
  launch_app: 29_000,
  click: 24_000,
  hover: 19_000,
  type_text: 94_000,
  press_key: 19_000,
  scroll: 24_000,
  drag: 24_000,
  set_value: 24_000,
  simulate_takeover: 5_000,
};
