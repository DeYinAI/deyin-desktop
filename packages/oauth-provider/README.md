# @deyin/oauth-provider

A standalone OAuth 2.0 / OpenID Connect provider for Openference. It issues tokens that
double as Bearer credentials for the Openference model gateway (`/v1`), so a user signs in
once and the same token authorizes model calls.

Built on [Hono](https://hono.dev) and [jose](https://github.com/panva/jose), it runs on
Node, Cloudflare Workers, Bun, and Deno.

## Supported flows

- Authorization Code + PKCE (S256 only) — RFC 6749 / RFC 7636
- Refresh Token with rotation — RFC 6749 §6
- Device Authorization Grant — RFC 8628 (headless / SSH)
- Token Introspection — RFC 7662
- Token Revocation — RFC 7009
- OIDC Discovery + JWKS

## Endpoints

| Path | Purpose |
| --- | --- |
| `GET  /.well-known/openid-configuration` | Discovery document |
| `GET  /oauth/jwks.json` | Public signing keys (RS256) |
| `GET/POST /oauth/authorize` | Authorization + consent |
| `POST /oauth/token` | `authorization_code`, `refresh_token`, `device_code` |
| `POST /oauth/device` | Start device flow |
| `GET/POST /oauth/device/verify` | Approve a device code |
| `GET/POST /oauth/userinfo` | OIDC UserInfo |
| `POST /oauth/introspect` | Validate a token |
| `POST /oauth/revoke` | Revoke a refresh token |

## Local dev

```bash
pnpm --filter @deyin/oauth-provider dev
# http://localhost:8788/.well-known/openid-configuration
# demo user: demo@deyin.dev   client: deyin-desktop
```

## Embedding in a real deployment

Implement `OAuthStorage` against Openference's user store and issue keys from a secret
manager:

```ts
import { createOAuthProvider, createKeystore } from "@deyin/oauth-provider";

const { app } = await createOAuthProvider({
  storage: new OpenferenceStorage(db),
  config: { issuer: "https://api.openference.com", audience: "https://api.openference.com/v1" },
  keys: { privateKeyPem: process.env.OAUTH_PRIVATE_KEY, publicKeyPem: process.env.OAUTH_PUBLIC_KEY, kid: "of-key-1" },
  corsOrigins: ["https://web.deyin.dev"],
});

export default app; // Workers, or serve() on Node
```

The only integration points are:

1. `getClient` / `getUser` / `findUserByEmail` — read from Openference's existing data.
2. The consent screen in `routes/authorize.ts` — swap the dev email form for Openference's
   existing Google/GitHub session + a consent step.

## Tokens

- **Access token**: RS256 JWT (`typ: at+jwt`, RFC 9068), 15 min. Verify against JWKS.
- **Refresh token**: opaque, 30 days, rotated on every use.
- **ID token**: RS256 JWT with OIDC claims, issued when `openid` is granted.
