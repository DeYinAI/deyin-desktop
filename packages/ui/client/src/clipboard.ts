import type { ContextMenuCommand, ContextMenuRequest } from "@deyin/contract";

/**
 * Clipboard access that works in every host.
 *
 * `navigator.clipboard` is the portable path, but it is not available
 * everywhere this UI runs: it needs a secure context plus a focused document,
 * and a packaged desktop build can lose that focus (a native menu, an
 * unfocused window, a locked screen). The desktop host therefore also exposes
 * Electron's clipboard, which always reaches the OS. We prefer the host bridge
 * when it exists and fall back to the web API for the browser-hosted build.
 */

/** Reads the system clipboard as text; empty string when unavailable. */
export async function readClipboardText(): Promise<string> {
  const bridge = window.deyin?.clipboard;
  try {
    if (bridge) return await bridge.readText();
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    // A denied permission or a non-secure context reads as "nothing there".
    return "";
  }
}

/**
 * Writes text to the system clipboard. Resolves false when the host refused,
 * so callers never show a "copied" state for a copy that did not happen.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  const bridge = window.deyin?.clipboard;
  try {
    if (bridge) return await bridge.writeText(text);
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shows the native right-click menu and resolves the chosen command.
 *
 * Returns null in the browser host, which has no native menu to show; callers
 * let the platform's own context menu handle the event in that case.
 */
export async function showContextMenu(
  request: ContextMenuRequest,
): Promise<ContextMenuCommand | null> {
  const bridge = window.deyin?.contextMenu;
  if (!bridge) return null;
  try {
    return await bridge.show(request);
  } catch {
    return null;
  }
}
