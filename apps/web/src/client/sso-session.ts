import type { TokenSet } from "@deyin/oauth-client";

const TOKEN_KEY = "deyin.tokens";
/** Session tokens from openference.com SSO last ~30 days; refresh is unavailable. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface MeResponse {
  id?: number;
  userId?: number;
  email?: string;
}

/**
 * Accept a dashboard session token handoff from openference.com (`?session=…`).
 * Validates via same-origin `/api/me` (Worker proxies to openference.com).
 */
export async function maybeBootstrapSsoSession(): Promise<void> {
  const url = new URL(window.location.href);
  const session = url.searchParams.get("session")?.trim();
  if (!session) return;

  url.searchParams.delete("session");
  window.history.replaceState({}, "", url.toString());

  const res = await fetch(`${location.origin}/api/me`, {
    headers: { authorization: `Bearer ${session}` },
  });
  if (!res.ok) {
    localStorage.removeItem(TOKEN_KEY);
    return;
  }

  const me = (await res.json()) as MeResponse;
  if (!me.email && !me.id && !me.userId) {
    localStorage.removeItem(TOKEN_KEY);
    return;
  }

  const tokens: TokenSet = {
    accessToken: session,
    tokenType: "Bearer",
    expiresAt: Date.now() + SESSION_TTL_MS,
    scope: "openid profile email model:invoke",
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}
