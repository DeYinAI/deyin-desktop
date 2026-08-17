import type { OAuthClientConfig, ProviderEndpoints } from "./types.js";
import { OAuthClientError } from "./types.js";

interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  device_authorization_endpoint: string;
  revocation_endpoint: string;
}

/**
 * Resolve provider endpoints. Uses explicit overrides when given, otherwise fetches the
 * OIDC discovery document from `{issuer}/.well-known/openid-configuration`.
 */
export async function resolveEndpoints(config: OAuthClientConfig): Promise<ProviderEndpoints> {
  const issuer = config.issuer.replace(/\/+$/, "");
  const o = config.endpoints ?? {};
  if (
    o.authorizationEndpoint &&
    o.tokenEndpoint &&
    o.userinfoEndpoint &&
    o.deviceAuthorizationEndpoint &&
    o.revocationEndpoint
  ) {
    return {
      issuer,
      authorizationEndpoint: o.authorizationEndpoint,
      tokenEndpoint: o.tokenEndpoint,
      userinfoEndpoint: o.userinfoEndpoint,
      deviceAuthorizationEndpoint: o.deviceAuthorizationEndpoint,
      revocationEndpoint: o.revocationEndpoint,
    };
  }

  const doFetch = config.fetch ?? fetch;
  const url = `${issuer}/.well-known/openid-configuration`;
  let doc: DiscoveryDoc;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = (await res.json()) as DiscoveryDoc;
  } catch (cause) {
    throw new OAuthClientError(`Failed to fetch discovery document from ${url}`, "discovery_failed", cause);
  }

  return {
    issuer: doc.issuer ?? issuer,
    authorizationEndpoint: o.authorizationEndpoint ?? doc.authorization_endpoint,
    tokenEndpoint: o.tokenEndpoint ?? doc.token_endpoint,
    userinfoEndpoint: o.userinfoEndpoint ?? doc.userinfo_endpoint,
    deviceAuthorizationEndpoint: o.deviceAuthorizationEndpoint ?? doc.device_authorization_endpoint,
    revocationEndpoint: o.revocationEndpoint ?? doc.revocation_endpoint,
  };
}
