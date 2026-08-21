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
