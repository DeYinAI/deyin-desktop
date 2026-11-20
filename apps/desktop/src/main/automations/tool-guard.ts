import { checkBrowserCall } from "./consent.js";
import { shellInputRefusal } from "./shell-guard.js";

/**
 * The checks an unattended run's tool calls go through before anything else (hooks included): browser
 * calls are held to the automation's consent, and the shell may not type or click on the screen. A
 * refusal is returned to the model as the tool's result, so its text says what to do instead.
 */
export function guardToolCall(tool: string, args: Record<string, unknown>, browserOrigins: readonly string[]): { block: string } | undefined {
  const browser = checkBrowserCall(tool, args, browserOrigins);
  if (!browser.allow) return { block: browser.reason };
  if (tool === "bash") {
    const refusal = shellInputRefusal(typeof args.command === "string" ? args.command : "");
    if (refusal) return { block: refusal };
  }
  return undefined;
}
