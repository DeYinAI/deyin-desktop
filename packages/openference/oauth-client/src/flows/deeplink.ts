import type { OAuthClient } from "../client.js";
import { generatePkce, generateState } from "../pkce.js";
import { OAuthClientError, type TokenSet } from "../types.js";

export interface DeepLinkLoginStart {
  /** The authorization URL to open in the system browser. */
  authorizationUrl: string;
  /** Feed the full `deyin://oauth/callback?...` URL received by the app. */
  complete(callbackUrl: string): Promise<TokenSet>;
  /** The state value, for callers that want to correlate windows. */
  state: string;
}

export interface DeepLinkLoginOptions {
  /**
   * The app's custom-scheme redirect, e.g. "deyin://oauth/callback". Must be a
   * registered redirect URI for the client.
   */
  redirectUri: string;
}

/**
 * Begin a native deep-link login (RFC 8252 with a private-use URI scheme).
 *
 * Unlike the loopback flow, the browser returns to the OS which routes the
 * custom-scheme URL back to the app; the app then calls `complete()` with that
 * URL. PKCE + state are held in the returned closure so the caller does not
 * manage them. This is the flow used with the Openference completion page,
 * which fires `deyin://oauth/callback?code=...&state=...`.
 */
export async function beginDeepLinkLogin(
  client: OAuthClient,
  options: DeepLinkLoginOptions,
): Promise<DeepLinkLoginStart> {
  const endpoints = await client.getEndpoints();
  const pkce = await generatePkce();
  const state = generateState();

  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.config.clientId);
  authUrl.searchParams.set("redirect_uri", options.redirectUri);
  authUrl.searchParams.set("scope", client.config.scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", pkce.method);

  return {
    authorizationUrl: authUrl.toString(),
    state,
    async complete(callbackUrl: string): Promise<TokenSet> {
      let url: URL;
      try {
        url = new URL(callbackUrl);
      } catch {
        throw new OAuthClientError("Malformed callback URL.", "bad_callback");
      }
      const error = url.searchParams.get("error");
      if (error) throw new OAuthClientError(`Authorization error: ${error}`, error);

      const returnedState = url.searchParams.get("state");
      if (!returnedState || returnedState !== state) {
        throw new OAuthClientError("State mismatch (possible CSRF).", "state_mismatch");
      }
      const code = url.searchParams.get("code");
      if (!code) throw new OAuthClientError("No authorization code returned.", "no_code");

      return client.exchangeCode({ code, codeVerifier: pkce.verifier, redirectUri: options.redirectUri });
    },
  };
}
