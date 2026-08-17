import type { OAuthClient } from "../client.js";
import { generatePkce, generateState } from "../pkce.js";
import { OAuthClientError, type TokenSet } from "../types.js";

const STORAGE_KEY = "deyin.oauth.pending";

interface PendingLogin {
  verifier: string;
  state: string;
  redirectUri: string;
}

/**
 * Begin a browser (SPA) login. Stashes the PKCE verifier + state in sessionStorage and
 * returns the authorization URL to navigate to. Call this, then set
 * `window.location.href = url`.
 */
export async function beginBrowserLogin(
  client: OAuthClient,
  redirectUri: string,
): Promise<string> {
  const endpoints = await client.getEndpoints();
  const pkce = await generatePkce();
  const state = generateState();

  const pending: PendingLogin = { verifier: pkce.verifier, state, redirectUri };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending));

  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", client.config.scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", pkce.method);
  return authUrl.toString();
}

/**
 * Complete a browser login on the redirect page. Reads `code`/`state` from the current
 * URL, validates state against the stashed value, and exchanges the code for tokens.
 */
export async function completeBrowserLogin(
  client: OAuthClient,
  currentUrl: string = window.location.href,
): Promise<TokenSet> {
  const url = new URL(currentUrl);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) throw new OAuthClientError(`Authorization error: ${error}`, error);
  if (!code || !state) throw new OAuthClientError("Missing code or state on callback.", "no_code");

  const rawPending = sessionStorage.getItem(STORAGE_KEY);
  if (!rawPending) throw new OAuthClientError("No pending login found.", "no_pending");
  const pending = JSON.parse(rawPending) as PendingLogin;
  if (pending.state !== state) throw new OAuthClientError("State mismatch (possible CSRF).", "state_mismatch");

  sessionStorage.removeItem(STORAGE_KEY);
  return client.exchangeCode({
    code,
    codeVerifier: pending.verifier,
    redirectUri: pending.redirectUri,
  });
}
