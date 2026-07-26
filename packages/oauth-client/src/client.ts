import { resolveEndpoints } from "./discovery.js";
import { MemoryTokenStore } from "./stores/memory.js";
import {
  OAuthClientError,
  type OAuthClientConfig,
  type ProviderEndpoints,
  type TokenSet,
  type TokenStore,
  type UserInfo,
} from "./types.js";

interface TokenEndpointResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** Refresh this many ms before the access token actually expires. */
const REFRESH_SKEW_MS = 30_000;

/**
 * Runtime-agnostic OAuth client. Owns token storage and refresh; the interactive login
 * step (loopback / device / browser redirect) is layered on top in `flows/*`.
 */
export class OAuthClient {
  readonly config: OAuthClientConfig;
  readonly store: TokenStore;
  private endpoints?: ProviderEndpoints;
  private readonly doFetch: typeof fetch;

  constructor(config: OAuthClientConfig, store: TokenStore = new MemoryTokenStore()) {
    this.config = config;
    this.store = store;
    this.doFetch = config.fetch ?? fetch;
  }

  async getEndpoints(): Promise<ProviderEndpoints> {
    if (!this.endpoints) this.endpoints = await resolveEndpoints(this.config);
    return this.endpoints;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.store.load()) !== undefined;
  }

  async getTokens(): Promise<TokenSet | undefined> {
    return this.store.load();
  }

  /** Exchange an authorization code (+ PKCE verifier) for tokens. */
  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<TokenSet> {
    const { tokenEndpoint } = await this.getEndpoints();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.config.clientId,
      code_verifier: input.codeVerifier,
    });
    if (this.config.clientSecret) body.set("client_secret", this.config.clientSecret);
    const tokens = await this.postToken(tokenEndpoint, body);
    await this.store.save(tokens);
    return tokens;
  }

  /** Exchange an approved device_code for tokens. */
  async exchangeDeviceCode(deviceCode: string): Promise<TokenSet> {
    const { tokenEndpoint } = await this.getEndpoints();
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: this.config.clientId,
    });
    if (this.config.clientSecret) body.set("client_secret", this.config.clientSecret);
    const tokens = await this.postToken(tokenEndpoint, body);
    await this.store.save(tokens);
    return tokens;
  }

  /** Force a refresh using the stored refresh token. */
  async refresh(): Promise<TokenSet> {
    const current = await this.store.load();
    if (!current?.refreshToken) {
      throw new OAuthClientError("No refresh token available.", "no_refresh_token");
    }
    const { tokenEndpoint } = await this.getEndpoints();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: this.config.clientId,
    });
    if (this.config.clientSecret) body.set("client_secret", this.config.clientSecret);
    const tokens = await this.postToken(tokenEndpoint, body);
    // Carry forward a refresh token if the server did not rotate one.
    if (!tokens.refreshToken) tokens.refreshToken = current.refreshToken;
    await this.store.save(tokens);
    return tokens;
  }

  /**
   * Return a valid access token, refreshing automatically if it is expired or within
   * the refresh skew window. Throws if there is no session.
   */
  async getAccessToken(): Promise<string> {
    const current = await this.store.load();
    if (!current) throw new OAuthClientError("Not authenticated.", "not_authenticated");
    if (Date.now() < current.expiresAt - REFRESH_SKEW_MS) return current.accessToken;
    if (current.refreshToken) return (await this.refresh()).accessToken;
    throw new OAuthClientError("Access token expired and no refresh token.", "expired");
  }

  /** Fetch the user profile from the UserInfo endpoint. */
  async getUser(): Promise<UserInfo> {
    const { userinfoEndpoint } = await this.getEndpoints();
    const accessToken = await this.getAccessToken();
    const res = await this.doFetch(userinfoEndpoint, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new OAuthClientError(`UserInfo failed: HTTP ${res.status}`, "userinfo_failed");
    const raw = (await res.json()) as Record<string, unknown>;
    return {
      sub: String(raw.sub),
      email: raw.email as string | undefined,
      emailVerified: raw.email_verified as boolean | undefined,
      name: raw.name as string | undefined,
      picture: raw.picture as string | undefined,
      plan: raw.plan as string | undefined,
    };
  }

  /** Revoke the refresh token (best effort) and clear local storage. */
  async logout(): Promise<void> {
    const current = await this.store.load();
    if (current?.refreshToken) {
      try {
        const { revocationEndpoint } = await this.getEndpoints();
        await this.doFetch(revocationEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: current.refreshToken, client_id: this.config.clientId }),
        });
      } catch {
        // Revocation is best effort; clearing local state is what matters.
      }
    }
    await this.store.clear();
  }

  private async postToken(endpoint: string, body: URLSearchParams): Promise<TokenSet> {
    const res = await this.doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as TokenEndpointResponse;
    if (!res.ok || data.error) {
      throw new OAuthClientError(
        data.error_description ?? data.error ?? `Token request failed: HTTP ${res.status}`,
        data.error ?? "token_request_failed",
      );
    }
    return {
      accessToken: data.access_token,
      tokenType: data.token_type,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope ?? this.config.scopes.join(" "),
      refreshToken: data.refresh_token,
      idToken: data.id_token,
    };
  }
}
