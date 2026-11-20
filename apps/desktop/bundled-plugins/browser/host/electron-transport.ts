import type { WebContents } from "electron";
import type { CdpTransport } from "./cdp-page.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const FOCUS_SETTLE_MS = 80;

/**
 * CDP over an Electron webContents (`wc.debugger`), so the in-app browser uses
 * the same page driver as the user's Chrome: trusted input events and an
 * accessibility-tree snapshot instead of `el.click()` and DOM mutation.
 *
 * The debugger can be detached from outside (DevTools opening, the guest
 * navigating across processes). `onDetach` lets the owner throw away the
 * page driver, because its enabled domains and node references die with the
 * session.
 */
export class ElectronDebuggerTransport implements CdpTransport {
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly onMessage = (_event: unknown, method: string, params: unknown): void => {
    const set = this.handlers.get(method);
    if (!set) return;
    for (const handler of [...set]) handler(params);
  };
  private readonly onDetached = (): void => {
    this.dispose();
    this.detachListener?.();
  };
  private disposed = false;
  private focusEmulated = false;

  constructor(
    private readonly wc: WebContents,
    private readonly detachListener?: () => void,
  ) {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    wc.debugger.on("message", this.onMessage);
    wc.debugger.on("detach", this.onDetached);
  }

  get alive(): boolean {
    return !this.disposed && !this.wc.isDestroyed() && this.wc.debugger.isAttached();
  }

  /**
   * Make the page ready for input without stealing focus from the user where
   * that can be avoided. Pointer input only needs focus emulation (the user is
   * usually typing in the chat composer). Keyboard and text input are dropped
   * by a guest that does not hold focus, so those also focus the guest's
   * <webview> element, which is the only focus call that works on a guest.
   */
  async ensureRenderable(opts?: { keyboard?: boolean }): Promise<void> {
    if (!this.focusEmulated) {
      await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      this.focusEmulated = true;
    }
    if (opts?.keyboard && (await this.focusGuest())) {
      // The renderer applies focus asynchronously; text sent before that lands nowhere.
      await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
    }
  }

  /** Focus this guest's <webview> in its host page. True when focus actually moved. */
  private async focusGuest(): Promise<boolean> {
    const host = this.wc.hostWebContents;
    if (!host || host.isDestroyed()) return false;
    try {
      return (await host.executeJavaScript(
        `(() => {
          for (const w of document.querySelectorAll("webview")) {
            try {
              if (w.getWebContentsId() !== ${this.wc.id}) continue;
              if (document.activeElement === w) return false;
              w.focus();
              return true;
            } catch { /* not a ready webview */ }
          }
          return false;
        })()`,
      )) === true;
    } catch {
      return false;
    }
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, opts?: { timeoutMs?: number }): Promise<T> {
    if (!this.alive) throw new Error("The browser tab is no longer available.");
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
    });
    try {
      return (await Promise.race([this.wc.debugger.sendCommand(method, params), timeout])) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  on(method: string, handler: (params: unknown) => void): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Stop listening. Leaves the debugger attached; other code may share it. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.handlers.clear();
    if (this.wc.isDestroyed()) return;
    this.wc.debugger.removeListener("message", this.onMessage);
    this.wc.debugger.removeListener("detach", this.onDetached);
  }
}
