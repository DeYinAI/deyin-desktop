/**
 * Deyin's own service configuration. Points at Openference for identity + models and at
 * Deyin's CDN for updates. Values can be overridden by env vars (see resolveDeyinConfig)
 * for local development.
 */
export interface DeyinConfig {
  oauthIssuer: string;
  apiBaseUrl: string;
  clientId: string;
  scopes: string[];
  updateFeedUrl: string;
  remoteConfigUrl: string;
}

export const DEFAULT_CONFIG: DeyinConfig = {
  // Identity issuer = the Openference site (hosts /oauth + /app/oauth pages);
  // the model API lives on the api. subdomain.
  oauthIssuer: "https://openference.com",
  apiBaseUrl: "https://api.openference.com/v1",
  clientId: "deyin-desktop",
  // `billing:manage` is first-party-only on the issuer (it reaches
  // select-plan); without it the billing routes answer 403 "Session login
  // required" because the desktop never holds a dashboard session token.
  scopes: ["openid", "profile", "email", "offline_access", "model:invoke", "billing:manage"],
  updateFeedUrl: "https://cdn.deyin.ai/desktop/releases",
  remoteConfigUrl: "https://cdn.deyin.ai/desktop/config/default.json",
};

/** Custom protocol + redirect used for the desktop deep-link OAuth callback. */
export const DEEP_LINK_SCHEME = "deyin";
export const DEEP_LINK_REDIRECT_URI = "deyin://oauth/callback";

/**
 * Resolve the effective config, allowing env overrides so a developer can point the app
 * at a local OAuth provider (`pnpm oauth:dev`) without editing source. Safe to call in a
 * browser bundle (falls back to defaults when `process` is absent).
 */
export function resolveDeyinConfig(
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): DeyinConfig {
  return {
    oauthIssuer: env.DEYIN_OAUTH_ISSUER ?? DEFAULT_CONFIG.oauthIssuer,
    apiBaseUrl: env.DEYIN_API_BASE_URL ?? DEFAULT_CONFIG.apiBaseUrl,
    clientId: env.DEYIN_CLIENT_ID ?? DEFAULT_CONFIG.clientId,
    scopes: DEFAULT_CONFIG.scopes,
    updateFeedUrl: env.DEYIN_UPDATE_FEED ?? DEFAULT_CONFIG.updateFeedUrl,
    remoteConfigUrl: env.DEYIN_REMOTE_CONFIG ?? DEFAULT_CONFIG.remoteConfigUrl,
  };
}
