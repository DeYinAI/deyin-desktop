import { computerUseConfirmationRequired } from "@deyin/agent-core";

/** Tool names and prefixes that must prompt even under full-access / automation skipAll. */
export const NEVER_SKIP_TOOLS = new Set([
  "computer_launch_app",
  "computer_set_value",
  "chrome_navigate",
]);

export const NEVER_SKIP_PREFIXES = ["computer_", "mcp__"];

export function requiresExtraConfirmation(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName.startsWith("computer_")) {
    return computerUseConfirmationRequired({ toolName, args });
  }
  return false;
}
