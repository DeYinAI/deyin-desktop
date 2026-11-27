import type { TokenSet } from "@deyin/oauth-client";

/**
 * Sign-in hand-off from openference.com, without a DOM so it can be tested on its own.
 *
 * The app starts a sign-in with `beginSsoSignIn`: it keeps a random value of its own and asks the site
 * to come back to `/?sso_state=<value>`. The site sends the browser back with a single-use code added
 * (`?sso_code=`), and the code is traded for the session only when the address carries a value this
 * browser is waiting for. That is what stops login CSRF. Anyone can sign in to an account of their own
 * on the site and get a code for it, but only this browser knows the value, so a link such as
 * `https://<this app>/?sso_code=<a code for the sender's account>` signs nobody in. Without the check,
 * whoever opened that link would be using the app inside the sender's account, and everything they then
 * wrote in it would be the sender's to read.
 *
 * The site no longer puts the session in the address, and neither does this app accept one: the old
 * `?session=<token>` link signed this browser in to whichever account the token belonged to, with no
 * question asked, which is the same hole. A copy of the site loaded before the code hand-off still sends
 * it; that visitor is simply signed out and signs in again (the site then hands over a code).
 */

export const SSO_CODE_PARAM = "sso_code";
export const SSO_STATE_PARAM = "sso_state";
/** The retired hand-off that carried the session itself. It is dropped from the address and never acted on. */
export const LEGACY_SESSION_PARAM = "session";
export const TOKEN_KEY = "deyin.tokens";
/** Sign-ins this browser started and is still waiting for. */
export const SSO_PENDING_KEY = "deyin.sso.pending";

/** Session tokens from openference.com SSO last ~30 days; refresh is unavailable. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A started sign-in stays valid this long: time to type a password and a second factor, not to forget it. */
export const SSO_PENDING_TTL_MS = 10 * 60 * 1000;
/** Sign-ins kept at once (tabs, a retry), the oldest dropped first. */
const SSO_PENDING_MAX = 5;
/** Shorter than any value this app makes (22 characters), so a stored scrap can never match. */
const MIN_STATE_LENGTH = 16;

export interface KeyValueStore {
  getItem(key: string): string | null;
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

export interface BeginSsoEnv {
  /** This app's own origin: where the site sends the browser back to. */
  origin: string;
  /** The Openference site that signs the visitor in. */
  issuer: string;
  storage: KeyValueStore;
  now(): number;
  /** A fresh unguessable value. */
  randomState(): string;
}

interface MeResponse {
  id?: number;
  userId?: number;
  email?: string;
}

interface PendingSignIn {
  state: string;
  at: number;
}

/** 128 random bits, URL-safe. */
export function randomSsoState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The sign-ins still waiting, without the expired ones and without anything that is not one. */
function readPending(storage: KeyValueStore, now: number): PendingSignIn[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SSO_PENDING_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is PendingSignIn =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as PendingSignIn).state === "string" &&
        (p as PendingSignIn).state.length >= MIN_STATE_LENGTH &&
        typeof (p as PendingSignIn).at === "number" &&
        now - (p as PendingSignIn).at < SSO_PENDING_TTL_MS &&
        (p as PendingSignIn).at <= now + 60_000
    );
  } catch {
    return [];
  }
}

function writePending(storage: KeyValueStore, pending: PendingSignIn[]): void {
  if (pending.length === 0) storage.removeItem(SSO_PENDING_KEY);
  else storage.setItem(SSO_PENDING_KEY, JSON.stringify(pending));
}

/**
 * Start a sign-in: remember a fresh value and return the address of the site to send the browser to. The
 * value rides inside the address the site returns to, so every way of signing in on the site (password,
 * Google, an already open session) brings it back unchanged.
 */
export function beginSsoSignIn(env: BeginSsoEnv): string {
  const state = env.randomState();
  const now = env.now();
  const pending = [...readPending(env.storage, now), { state, at: now }].slice(-SSO_PENDING_MAX);
  writePending(env.storage, pending);

  const returnTo = new URL("/", env.origin);
  returnTo.searchParams.set(SSO_STATE_PARAM, state);
  return `${env.issuer.replace(/\/+$/, "")}/auth/sso?redirect=${encodeURIComponent(returnTo.toString())}`;
}

/**
 * True, once, when `state` is one this browser started and has not used. A value that matches nothing leaves
 * the sign-ins that are really waiting alone: a stranger's link must not be able to cancel the sign-in in
 * another tab. Only an exact match is used up.
 */
function consumePendingState(env: SsoHandoffEnv, state: string): boolean {
  const pending = readPending(env.storage, env.now());
  const index = pending.findIndex((p) => p.state === state);
  if (index === -1) return false;
  writePending(env.storage, pending.filter((_, i) => i !== index));
  return true;
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
 * stays in the bar or the history entry. A code is traded only when the address also carries a value this
 * browser started a sign-in with (`beginSsoSignIn`); that value is used up first, so the same address
 * works once. A code that arrives without one is dropped unopened. A code that does not trade, or a session
 * that does not validate, never touches an existing sign-in: a stale or foreign link must not be able to
 * sign someone out, any more than in.
 */
export async function bootstrapSsoSession(env: SsoHandoffEnv): Promise<void> {
  const url = new URL(env.href);
  const code = url.searchParams.get(SSO_CODE_PARAM)?.trim() || null;
  const state = url.searchParams.get(SSO_STATE_PARAM)?.trim() || null;
  const hasLegacySession = url.searchParams.has(LEGACY_SESSION_PARAM);
  if (!code && !hasLegacySession) return;

  url.searchParams.delete(SSO_CODE_PARAM);
  url.searchParams.delete(SSO_STATE_PARAM);
  url.searchParams.delete(LEGACY_SESSION_PARAM);
  env.replaceUrl(url.toString());

  if (!code) return;
  if (!state || !consumePendingState(env, state)) return;

  const session = await tradeCodeForSession(env, code);
  if (!session) return;
  if (!(await sessionIsValid(env, session))) return;

  const tokens: TokenSet = {
    accessToken: session,
    tokenType: "Bearer",
    expiresAt: env.now() + SESSION_TTL_MS,
    scope: "openid profile email model:invoke",
  };
  env.storage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}
