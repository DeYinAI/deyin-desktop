# Deployment

Deyin ships three deployable units. All are original code and can be self-hosted.

## 1. Openference OAuth provider (`@deyin/oauth-provider`)

Runs on Node or Cloudflare Workers alongside the existing Openference API.

- Provide RS256 keys from a secret manager (`createOAuthProvider({ keys })`).
- Implement `OAuthStorage` over the Openference user DB.
- Terminate TLS at `https://api.openference.com`; mount routes under `/oauth/*` and
  `/.well-known/openid-configuration`.

See [OAUTH.md](./OAUTH.md) and [DEPLOY-OPENFERENCE-OAUTH.md](./DEPLOY-OPENFERENCE-OAUTH.md).

## 2. Web app (`@deyin/web`)

- **Client**: `pnpm --filter @deyin/web build` → `dist/client` static assets. Put behind
  a CDN. Configure `VITE_DEYIN_OAUTH_ISSUER` at build time.
- **Host-server**: `dist/server/index.js`. Deploy behind a WebSocket-aware proxy. Run one
  **sandboxed container per authenticated session**; mount that container's workspace as
  the session root passed to `SessionHost`. Add an idle reaper to reclaim sessions.
- The `/api` route proxies model calls to Openference with the caller's Bearer token, so
  the browser never makes cross-origin model requests.

## 3. Desktop config CDN (optional)

Remote feature flags and defaults:

| Purpose | URL | Source in repo |
| --- | --- | --- |
| Remote config | `https://cdn.deyin.ai/desktop/config/default.json` | `infra/cdn/desktop/config/default.json` |

### Desktop auto-update (v1)

Packaged desktop apps poll the **public GitHub release feed**, not the CDN:

| Purpose | URL |
| --- | --- |
| Update feed | [`DeYinAI/deyin-releases`](https://github.com/DeYinAI/deyin-releases) |

CI publishes installers and `latest*.yml` manifests on each `v*` tag. See [RELEASE.md](./RELEASE.md).

Optional: mirror the same assets to `cdn.deyin.ai/desktop/releases` if you operate a CDN
in front of the GitHub feed — not required for the default build.
