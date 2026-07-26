import { Hono } from "hono";
import { ENDPOINTS } from "../config.js";
import type { ProviderContext } from "../context.js";
import { publicJwks } from "../jwt.js";

/** OIDC discovery document + JWKS. Lets clients auto-configure from the issuer. */
export function discoveryRoutes(ctx: ProviderContext): Hono {
  const app = new Hono();
  const { issuer } = ctx.config;

  app.get(ENDPOINTS.discovery, (c) =>
    c.json({
      issuer,
      authorization_endpoint: issuer + ENDPOINTS.authorize,
      token_endpoint: issuer + ENDPOINTS.token,
      userinfo_endpoint: issuer + ENDPOINTS.userinfo,
      device_authorization_endpoint: issuer + ENDPOINTS.device,
      introspection_endpoint: issuer + ENDPOINTS.introspect,
      revocation_endpoint: issuer + ENDPOINTS.revoke,
      jwks_uri: issuer + ENDPOINTS.jwks,
      scopes_supported: ctx.config.supportedScopes,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    }),
  );

  app.get(ENDPOINTS.jwks, async (c) => c.json(await publicJwks(ctx.keystore)));

  return app;
}
