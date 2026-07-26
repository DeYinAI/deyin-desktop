export interface OAuthClientConfig {
  /** Issuer base URL, e.g. https://api.openference.com. */
  issuer: string;
  /** Registered public client id, e.g. "deyin-desktop". */
  clientId: string;
  /** Scopes to request. */
  scopes: string[];
  /**
   * Optional confidential client secret. Public clients (desktop/CLI/SPA) omit this and
   * rely on PKCE.
   */
  clientSecret?: string;
  /** Override discovery with explicit endpoints (skips the discovery fetch). */
  endpoints?: Partial<ProviderEndpoints>;
  /** Custom fetch (tests, proxies). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface ProviderEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  deviceAuthorizationEndpoint: string;
  revocationEndpoint: string;
}

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  /** Absolute expiry, epoch ms. */
  expiresAt: number;
  scope: string;
  refreshToken?: string;
  idToken?: string;
}

export interface UserInfo {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  plan?: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** Persists a token set between runs. */
export interface TokenStore {
  load(): Promise<TokenSet | undefined>;
  save(tokens: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

export class OAuthClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OAuthClientError";
  }
}
