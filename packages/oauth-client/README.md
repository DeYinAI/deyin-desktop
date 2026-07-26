# @deyin/oauth-client

A small, dependency-free OAuth 2.0 + PKCE client for Openference. One library, three login
styles, shared token storage and auto-refresh:

- **Desktop / native** — loopback redirect on `127.0.0.1` (RFC 8252)
- **CLI / headless** — device authorization grant (RFC 8628)
- **Browser / SPA** — authorization-code redirect

Any tool (not just Deyin) can add "Sign in with Openference" by importing this package.

## Install

```bash
pnpm add @deyin/oauth-client
```

## Core client

```ts
import { OAuthClient } from "@deyin/oauth-client";

const client = new OAuthClient({
  issuer: "https://api.openference.com",
  clientId: "deyin-desktop",
  scopes: ["openid", "profile", "email", "offline_access", "model:invoke"],
});

// A valid access token, auto-refreshed when near expiry:
const token = await client.getAccessToken();
const user = await client.getUser();
```

## Desktop loopback login

```ts
import { OAuthClient } from "@deyin/oauth-client";
import { loginWithLoopback, FileTokenStore } from "@deyin/oauth-client/node";

const client = new OAuthClient(
  { issuer, clientId, scopes },
  new FileTokenStore({ path: `${process.env.HOME}/.deyin/credentials.json` }),
);

await loginWithLoopback(client, {
  onAuthUrl: (url) => console.log("Opening:", url),
});
```

In Electron, inject the OS keychain by passing `encrypt`/`decrypt` from `safeStorage`:

```ts
import { safeStorage } from "electron";
new FileTokenStore({
  path: credsPath,
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b),
});
```

## CLI device login (headless / SSH)

```ts
import { loginWithDevice } from "@deyin/oauth-client/node";

await loginWithDevice(client, {
  onAuthorization: ({ userCode, verificationUri }) => {
    console.log(`Go to ${verificationUri} and enter code: ${userCode}`);
  },
});
```

## Browser (SPA)

```ts
import { beginBrowserLogin, completeBrowserLogin } from "@deyin/oauth-client/browser";

// On a "Sign in" click:
location.href = await beginBrowserLogin(client, `${location.origin}/auth/callback`);

// On the /auth/callback page:
const tokens = await completeBrowserLogin(client);
```

## Token storage

- `MemoryTokenStore` — non-persistent (tests, short-lived processes).
- `FileTokenStore` — JSON at `0600`, optionally encrypted via an injected keychain.
- Implement `TokenStore` yourself for anything else.

## Runnable example

See [`examples/cli-login.ts`](examples/cli-login.ts) — a complete third-party CLI login:

```bash
# with the dev provider running (pnpm oauth:dev):
pnpm --filter @deyin/oauth-client exec tsx examples/cli-login.ts --issuer http://localhost:8788
```
