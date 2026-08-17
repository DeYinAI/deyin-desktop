import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

export interface ComputerUseHostApi {
  listApps(): Promise<unknown>;
  listWindows(): Promise<unknown>;
  getWindowState(windowId: string, opts?: { screenshot?: boolean; tree?: boolean }): Promise<unknown>;
  launchApp(appId: string): Promise<unknown>;
  click(windowId: string, ref: string): Promise<unknown>;
  typeText(windowId: string, text: string, ref?: string): Promise<unknown>;
  pressKey(windowId: string, key: string): Promise<unknown>;
  scroll(windowId: string, deltaY: number): Promise<unknown>;
  drag(windowId: string, fromRef: string, toRef: string): Promise<unknown>;
  setValue(windowId: string, ref: string, value: string): Promise<unknown>;
  cancel?(): Promise<void>;
  ping(): Promise<boolean>;
}

/** In-process mock host for dev/tests on non-Windows platforms. */
export class MockComputerUseHost implements ComputerUseHostApi {
  async listApps() {
    return [{ id: "notepad", name: "Notepad", path: "notepad.exe" }];
  }
  async listWindows() {
    return [{ id: "win-1", title: "Mock Window", app: "notepad" }];
  }
  async getWindowState() {
    return {
      windowId: "win-1",
      title: "Mock Window",
      screenshotPath: null,
      tree: [{ ref: "e1", role: "button", name: "OK" }],
    };
  }
  async launchApp(appId: string) {
    return { launched: appId, windowId: "win-1" };
  }
  async click() {
    return { ok: true };
  }
  async typeText() {
    return { ok: true };
  }
  async pressKey() {
    return { ok: true };
  }
  async scroll() {
    return { ok: true };
  }
  async drag() {
    return { ok: true };
  }
  async setValue() {
    return { ok: true };
  }
  async ping() {
    return true;
  }
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
