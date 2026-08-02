/** Validates OAuth callback `state` against the value issued for the session (CSRF protection). */
export function mcpOAuthCallbackStateValid(returned: string | null, expected: string | undefined): boolean {
  return Boolean(returned && expected && returned === expected);
}
