/**
 * Deyin's own service configuration. Points at Openference for identity + models and at
 * Deyin's CDN for updates. Values can be overridden by env vars in the main process
 * (see main/config.ts) for local development.
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
  scopes: ["openid", "profile", "email", "offline_access", "model:invoke"],
  updateFeedUrl: "https://cdn.deyin.dev/desktop/releases",
  remoteConfigUrl: "https://cdn.deyin.dev/desktop/config/default.json",
};

/** Custom protocol + redirect used for the desktop deep-link OAuth callback. */
export const DEEP_LINK_SCHEME = "deyin";
export const DEEP_LINK_REDIRECT_URI = "deyin://oauth/callback";
