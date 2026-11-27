import { bootstrapSsoSession } from "./sso-handoff.js";

/** Same issuer the OAuth client in transport.ts talks to (baked in at build time). */
const OAUTH_ISSUER = (import.meta.env.VITE_DEYIN_OAUTH_ISSUER as string) ?? "http://localhost:8788";

/**
 * Accept the sign-in hand-off from openference.com: a single-use code (`?sso_code=`) that is traded
 * for the dashboard session, but only when it comes back with the value this browser started its
 * sign-in with (`?sso_state=`). The session is validated via same-origin `/api/me` (the Worker
 * proxies to openference.com). See sso-handoff.ts for the rules.
 */
export async function maybeBootstrapSsoSession(): Promise<void> {
  await bootstrapSsoSession({
    href: window.location.href,
    replaceUrl: (url) => window.history.replaceState({}, "", url),
    storage: localStorage,
    fetch: (input, init) => fetch(input, init),
    origin: location.origin,
    issuer: OAUTH_ISSUER,
    now: () => Date.now(),
  });
}
