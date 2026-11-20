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
 * automation may never take on its own: OS input synthesis (`computer_`).
 *
 * A prefix listed here stops `skipAll` from auto-allowing the tool, so an
 * execute-tier call falls back to "ask" and the automation resolver sees (and
 * denies) it.
 *
 * The user's real Chrome (`chrome_`) is deliberately not here. It used to be,
 * which made every Chrome call a refusal and left an automation that needed the
 * browser to improvise around it. Chrome is instead governed by the automation's
 * own per-site consent, enforced in the executor before each call (see
 * automations/consent.ts), and the tools are only present at all when that
 * consent exists.
 */
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
