/** Tool names and prefixes that must prompt even under full-access / automation skipAll. */
export const NEVER_SKIP_TOOLS = new Set<string>([]);

export const NEVER_SKIP_PREFIXES = ["mcp__"];

export function requiresExtraConfirmation(_toolName: string, _args: Record<string, unknown>): boolean {
  return false;
}
