import { spawn } from "node:child_process";

/**
 * Open a URL in the user's default browser. Best effort and non-blocking; callers should
 * also print the URL so the user can open it manually if this fails (e.g. headless).
 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    // Not `cmd /c start`: cmd parses unquoted `&` as a command separator,
    // truncating OAuth URLs at the first query param. rundll32 receives the
    // URL as a plain argv element with no shell parsing at all.
    command = "rundll32";
    args = ["url.dll,FileProtocolHandler", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignore; the caller surfaces the URL for manual opening.
  }
}
