import type { TokenSet } from "@deyin/oauth-client";

/**
 * Sign-in hand-off from openference.com, without a DOM so it can be tested on its own.
 *
 * The site no longer puts the session in the address. It sends the browser here with a single-use
 * code (`?sso_code=`); this app trades the code for the session with one POST to the site and keeps
 * the session in local storage. A copy of the site that was loaded before that change still sends
 * the session itself (`?session=`): that path stays for one release and is the only one that does.
 * Anyone able to open `https://<this app>/?session=<token>` signs this browser in to that token's
 * account, so nothing new may start sending it.
 */

export const SSO_CODE_PARAM = "sso_code";
export const LEGACY_SESSION_PARAM = "session";
export const TOKEN_KEY = "deyin.tokens";

/** Session tokens from openference.com SSO last ~30 days; refresh is unavailable. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface KeyValueStore {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SsoHandoffEnv {
  /** The current address. */
  href: string;
  /** Replace the address shown in the bar and kept in this history entry. Does not navigate. */
  replaceUrl(url: string): void;
  storage: KeyValueStore;
  fetch: typeof fetch;
  /** This app's own origin: its Worker answers `/api/me`. */
  origin: string;
  /** The Openference site that issued the code. */
  issuer: string;
  now(): number;
}

interface MeResponse {
  id?: number;
  userId?: number;
  email?: string;
}

/**
 * Trade the single-use code for the session. The code works once and for about a minute, so null
 * for anything else (used, expired, unreachable): the caller carries on exactly as it was.
 */
async function tradeCodeForSession(env: SsoHandoffEnv, code: string): Promise<string | null> {
  try {
    const res = await env.fetch(`${env.issuer.replace(/\/+$/, "")}/auth/sso/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { session?: unknown };
    return typeof body.session === "string" && body.session ? body.session : null;
  } catch {
    return null;
  }
}

/** True when the same-origin `/api/me` (the Worker proxies to openference.com) knows this session. */
async function sessionIsValid(env: SsoHandoffEnv, session: string): Promise<boolean> {
  try {
    const res = await env.fetch(`${env.origin}/api/me`, {
      headers: { authorization: `Bearer ${session}` },
    });
    if (!res.ok) return false;
    const me = (await res.json()) as MeResponse;
    return Boolean(me.email || me.id || me.userId);
  } catch {
    return false;
  }
}

/**
 * Take a hand-off from the address, if there is one, and keep the session it carries.
 *
 * Whatever is in the address is removed before anything is awaited, so neither a code nor a session
 * stays in the bar or the history entry. A code that does not trade, or a session that does not
 * validate, never touches an existing sign-in when it came as a code: a stale link must not be able
 * to sign someone out. The legacy `?session=` path keeps its old behaviour of clearing the stored
 * tokens when the session it carried is not valid.
 */
export async function bootstrapSsoSession(env: SsoHandoffEnv): Promise<void> {
  const url = new URL(env.href);
  const code = url.searchParams.get(SSO_CODE_PARAM)?.trim() || null;
  const legacySession = url.searchParams.get(LEGACY_SESSION_PARAM)?.trim() || null;
  if (!code && !legacySession) return;

  url.searchParams.delete(SSO_CODE_PARAM);
  url.searchParams.delete(LEGACY_SESSION_PARAM);
  env.replaceUrl(url.toString());

  // A code takes precedence: when both are present the legacy session is ignored.
  const session = code ? await tradeCodeForSession(env, code) : legacySession;
  if (!session) return;

  if (!(await sessionIsValid(env, session))) {
    if (!code) env.storage.removeItem(TOKEN_KEY);
    return;
  }

  const tokens: TokenSet = {
    accessToken: session,
    tokenType: "Bearer",
    expiresAt: env.now() + SESSION_TTL_MS,
    scope: "openid profile email model:invoke",
  };
  env.storage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}
