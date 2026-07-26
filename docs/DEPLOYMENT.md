# Deployment

Deyin ships three deployable units. All are original code and can be self-hosted.

## 1. Openference OAuth provider (`@deyin/oauth-provider`)

Runs on Node or Cloudflare Workers alongside the existing Openference API.

- Provide RS256 keys from a secret manager (`createOAuthProvider({ keys })`).
- Implement `OAuthStorage` over the Openference user DB.
- Terminate TLS at `https://api.openference.com`; mount routes under `/oauth/*` and
  `/.well-known/openid-configuration`.

## 2. Web app (`@deyin/web`)

- **Client**: `pnpm --filter @deyin/web build` -> `dist/client` static assets. Put behind
  a CDN. Configure `VITE_DEYIN_OAUTH_ISSUER` at build time.
- **Host-server**: `dist/server/index.js`. Deploy behind a WebSocket-aware proxy. Run one
  **sandboxed container per authenticated session**; mount that container's workspace as
  the session root passed to `SessionHost`. Add an idle reaper to reclaim sessions.
- The `/api` route proxies model calls to Openference with the caller's Bearer token, so
  the browser never makes cross-origin model requests.

## 3. Desktop CDN (config + auto-update)

The desktop app reads two URLs (see `apps/desktop/src/shared/config.ts`):

| Purpose | URL | Source |
| --- | --- | --- |
| Remote config / feature flags | `https://cdn.deyin.ai/desktop/config/default.json` | `infra/cdn/desktop/config/default.json` |
| Update feed | `https://cdn.deyin.ai/desktop/releases` | electron-builder output |

### CDN layout (S3 + Cloudflare)

```
cdn.deyin.ai/
  desktop/
    config/default.json          # remote config (this repo: infra/cdn/...)
    releases/
      latest.yml                 # electron-updater manifest (Windows)
      latest-mac.yml             # macOS
      latest-linux.yml           # Linux
      Deyin-Setup-0.1.0.exe
      Deyin-0.1.0.dmg
      Deyin-0.1.0.AppImage
```

### Publishing releases

`electron-builder.yml` is configured with a generic publish provider pointing at the
release feed. To publish:

```bash
pnpm --filter @deyin/desktop package        # builds + produces installers in release/
# upload release/* (installers + *.yml manifests) to cdn.deyin.ai/desktop/releases/
```

`electron-updater` (wired in `main/updater.ts`) checks this feed on launch in packaged
builds and installs updates on quit.
