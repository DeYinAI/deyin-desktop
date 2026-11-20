import type { TeachCaptureDeps, TeachTarget } from "./teach-capture.js";

/**
 * What teaching needs of a browser tab's `WebContents`, so this can be tested without Electron. The real one is
 * assignable to it.
 */
export interface TeachWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * The world the watching script runs in. It shares the page's elements and events but not its scripts or globals, so
 * a page cannot see the script, call it or add to what it saw. Worlds 0 and 999 are the page's and Electron's own.
 */
export const TEACH_WORLD_ID = 1007;

/** A tab the person is working in, as capture sees it. */
export function teachTargetFromWebContents(wc: TeachWebContents): TeachTarget {
  return {
    id: wc.id,
    url: () => (wc.isDestroyed() ? "" : wc.getURL()),
    title: () => (wc.isDestroyed() ? "" : wc.getTitle()),
    run: async (script) => {
      if (wc.isDestroyed()) throw new Error("The tab is closed.");
      return wc.executeJavaScriptInIsolatedWorld(TEACH_WORLD_ID, [{ code: script }]);
    },
    onNavigate: (listener) => {
      // A page loading, or going somewhere else in the same document; frames inside the page are not the page.
      const loaded = (): void => listener();
      const inPage = (...args: unknown[]): void => {
        if (args[2] !== false) listener();
      };
      wc.on("dom-ready", loaded);
      wc.on("did-navigate", loaded);
      wc.on("did-navigate-in-page", inPage);
      return () => {
        wc.removeListener("dom-ready", loaded);
        wc.removeListener("did-navigate", loaded);
        wc.removeListener("did-navigate-in-page", inPage);
      };
    },
  };
}

/**
 * The tab the person is in, as a target, the same one each time for the same tab so it can tell when they have moved
 * to another. `current` is the browser's active tab, or null when none is open or it has gone.
 */
export function activeTeachTarget(current: () => TeachWebContents | null): TeachCaptureDeps["active"] {
  const known = new Map<number, TeachTarget>();
  return () => {
    const wc = current();
    if (!wc || wc.isDestroyed()) return null;
    let target = known.get(wc.id);
    if (!target) {
      target = teachTargetFromWebContents(wc);
      known.set(wc.id, target);
    }
    return target;
  };
}
