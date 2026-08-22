# Deploying Openference OAuth for Deyin

Guide for shipping the OAuth authorization server that Deyin desktop and CLI use for
“Sign in with Openference”.

## Overview

Production sign-in uses `https://openference.com` as the OAuth issuer. The standalone
provider in this repo (`@deyin/oauth-provider`) is for local development and reference;
production OAuth routes live on the Openference worker.

## Local verification

```bash
pnpm oauth:dev
# discovery: http://localhost:8788/.well-known/openid-configuration
# demo user: demo@deyin.ai   client: deyin-desktop
```

Run the provider test suite before any production deploy:

```bash
pnpm --filter @deyin/oauth-provider test
```

## Post-deploy smoke checklist

```bash
curl -s https://openference.com/.well-known/openid-configuration | jq .
curl -s https://openference.com/.well-known/jwks.json | jq .
```

Open the authorize URL in a browser while signed in to Openference (replace
`<S256>` with a PKCE challenge):

```
https://openference.com/app/oauth/authorize?response_type=code&client_id=deyin-desktop&redirect_uri=deyin%3A%2F%2Foauth%2Fcallback&scope=openid%20profile%20email%20model%3Ainvoke%20offline_access&state=test&code_challenge=<S256>&code_challenge_method=S256
```

## Desktop app

Default issuer is `https://openference.com` (see `apps/desktop/.env.example`). After the
provider is live, packaged desktop builds use deep-link sign-in (`deyin://oauth/callback`).

```bash
pnpm --filter @deyin/desktop package
# Linux: apps/desktop/release/*.deb, *.AppImage
# Windows: run package -- --win on a Windows host
```

## Known limitations

- End-to-end desktop round trip (browser → `deyin://` → auto sign-in) requires a packaged
  app on a real desktop OS plus the deployed provider.
- Email-login users sign in through Openference's existing account flow; the provider
  reuses that session system.
