/**
 * Persistence contracts for the OAuth provider.
 *
 * The in-memory implementation in `memory.ts` is used for local dev and tests.
 * A production deployment implements this interface against Openference's existing
 * user store (users) and issues/validates its own OAuth artifacts (codes, tokens,
 * device requests).
 */

export interface OAuthClient {
  clientId: string;
  /** Human-readable client name shown on the consent screen. */
  name: string;
  /** Public clients (desktop/CLI/SPA) have no secret and MUST use PKCE. */
  isPublic: boolean;
  /** Confidential client secret hash (unused for public clients). */
  secretHash?: string;
  /**
   * Allowed redirect URIs. Loopback entries may use a `*` port placeholder
   * (for example a localhost callback with wildcard port), which matches any
   * port per RFC 8252.
   */
  redirectUris: string[];
  /** Scopes this client is permitted to request. */
  allowedScopes: string[];
  /** Grant types the client may use. */
  grantTypes: GrantType[];
}

export type GrantType =
  | "authorization_code"
  | "refresh_token"
  | "urn:ietf:params:oauth:grant-type:device_code";

export interface UserProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
  /** Openference plan identifier, surfaced in userinfo + tokens. */
  plan?: string;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  sub: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  nonce?: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface RefreshTokenRecord {
  token: string;
  clientId: string;
  sub: string;
  scope: string;
  /** Epoch ms. */
  expiresAt: number;
}

export type DeviceStatus = "pending" | "approved" | "denied";

export interface DeviceCodeRecord {
  deviceCode: string;
  userCode: string;
  clientId: string;
  scope: string;
  status: DeviceStatus;
  sub?: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Minimum polling interval, seconds. */
  interval: number;
  /** Last poll time (epoch ms) for slow_down enforcement. */
  lastPolledAt?: number;
}

export interface OAuthStorage {
  getClient(clientId: string): Promise<OAuthClient | undefined>;

  getUser(sub: string): Promise<UserProfile | undefined>;
  /** Used by the dev consent screen to resolve a login to a user. */
  findUserByEmail(email: string): Promise<UserProfile | undefined>;

  saveAuthorizationCode(record: AuthorizationCodeRecord): Promise<void>;
  takeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined>;

  saveRefreshToken(record: RefreshTokenRecord): Promise<void>;
  takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined>;
  revokeRefreshToken(token: string): Promise<void>;

  saveDeviceCode(record: DeviceCodeRecord): Promise<void>;
  getDeviceCodeByDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | undefined>;
  getDeviceCodeByUserCode(userCode: string): Promise<DeviceCodeRecord | undefined>;
  updateDeviceCode(record: DeviceCodeRecord): Promise<void>;
}
