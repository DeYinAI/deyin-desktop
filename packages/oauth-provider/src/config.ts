export interface ProviderConfig {
  /** OAuth issuer, e.g. https://api.openference.com. No trailing slash. */
  issuer: string;
  /** Resource audience placed in access tokens (the model gateway). */
  audience: string;
  /** Access token lifetime, seconds. */
  accessTokenTtl: number;
  /** Refresh token lifetime, seconds. */
  refreshTokenTtl: number;
  /** Authorization code lifetime, seconds. */
  authCodeTtl: number;
  /** Device code lifetime, seconds. */
  deviceCodeTtl: number;
  /** Device flow minimum polling interval, seconds. */
  devicePollInterval: number;
  /** All scopes the provider recognizes. */
  supportedScopes: string[];
}

export const DEFAULT_CONFIG: ProviderConfig = {
  issuer: "https://api.openference.com",
  audience: "https://api.openference.com/v1",
  accessTokenTtl: 15 * 60,
  refreshTokenTtl: 30 * 24 * 60 * 60,
  authCodeTtl: 60,
  deviceCodeTtl: 10 * 60,
  devicePollInterval: 5,
  supportedScopes: ["openid", "profile", "email", "offline_access", "model:invoke"],
};

export function resolveConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const issuer = (overrides.issuer ?? DEFAULT_CONFIG.issuer).replace(/\/+$/, "");
  return { ...DEFAULT_CONFIG, ...overrides, issuer };
}

/** Endpoint paths, relative to the issuer. Centralized so discovery stays in sync. */
export const ENDPOINTS = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  userinfo: "/oauth/userinfo",
  device: "/oauth/device",
  introspect: "/oauth/introspect",
  revoke: "/oauth/revoke",
  jwks: "/oauth/jwks.json",
  discovery: "/.well-known/openid-configuration",
} as const;
