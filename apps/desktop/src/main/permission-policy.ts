import { computerUseConfirmationRequired } from "@deyin/agent-core";

/**
 * Tool names and prefixes that must prompt even under full-access / automation
 * skipAll. Deliberately empty: "full access" is a promise that the user is
 * never interrupted, and every remaining escape hatch (read-only/ask-first
 * modes, plan/ask deny rules, explicit deny rules) still overrides skipAll.
 */
export const NEVER_SKIP_TOOLS = new Set<string>([]);

export const NEVER_SKIP_PREFIXES: string[] = [];

export function requiresExtraConfirmation(_toolName: string, _args: Record<string, unknown>): boolean {
  return false;
}

/**
 * The same idea, but for unattended automation runs, where the reasoning above
 * does not hold: there is no user to interrupt, so a tool reaching the "ask"
 * tier cannot be answered and must be denied instead. These are the tools an
 * automation may never take on its own — OS input synthesis and browser
 * navigation, which can act on already-authenticated sessions.
 *
 * `deny` beats `skipAll` in PermissionEngine, so listing a tool here guarantees
 * the automation resolver sees it rather than it being auto-allowed.
 */
export const AUTOMATION_NEVER_SKIP_TOOLS = new Set<string>(["chrome_navigate"]);

export const AUTOMATION_NEVER_SKIP_PREFIXES: string[] = ["computer_"];

/**
 * Extra confirmation for an unattended run means "deny": high-risk computer-use
 * actions (purchases, sends, deletes, logins) are classified by agent-core and
 * must never fire without a human.
 */
export function automationRequiresExtraConfirmation(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName.startsWith("computer_")) return computerUseConfirmationRequired({ toolName, args });
  return requiresExtraConfirmation(toolName, args);
}
