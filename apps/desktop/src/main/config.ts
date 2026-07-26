import { DEFAULT_CONFIG, type DeyinConfig } from "../shared/config.js";

/**
 * Resolve the effective config, allowing env overrides so a developer can point the app
 * at a local OAuth provider (`pnpm oauth:dev`) without editing source.
 */
export function resolveDeyinConfig(): DeyinConfig {
  const env = process.env;
  return {
    oauthIssuer: env.DEYIN_OAUTH_ISSUER ?? DEFAULT_CONFIG.oauthIssuer,
    apiBaseUrl: env.DEYIN_API_BASE_URL ?? DEFAULT_CONFIG.apiBaseUrl,
    clientId: env.DEYIN_CLIENT_ID ?? DEFAULT_CONFIG.clientId,
    scopes: DEFAULT_CONFIG.scopes,
    updateFeedUrl: env.DEYIN_UPDATE_FEED ?? DEFAULT_CONFIG.updateFeedUrl,
    remoteConfigUrl: env.DEYIN_REMOTE_CONFIG ?? DEFAULT_CONFIG.remoteConfigUrl,
  };
}
