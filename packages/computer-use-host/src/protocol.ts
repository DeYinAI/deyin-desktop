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

export const PIPE_NAME = "deyin-computer-use";

export type ComputerUseMethod =
  | "list_apps"
  | "list_windows"
  | "get_window"
  | "launch_app"
  | "get_window_state"
  | "click"
  | "type_text"
  | "press_key"
  | "scroll"
  | "drag"
  | "set_value"
  | "ping";
