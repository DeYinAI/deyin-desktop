# @deyin/web

Deyin on the web. It serves the **same renderer** as the desktop app (reused verbatim via
a Vite alias) and replaces the Electron main process with a **per-session host-server**.

## How it maps to desktop

| Concern | Desktop | Web |
| --- | --- | --- |
| UI | `apps/desktop/src/renderer` | same source, aliased as `@renderer` |
| Host API (`window.deyin`) | preload over Electron IPC | `createBrowserTransport()` over WebSocket + HTTP |
| Terminal / files | main-process host | `src/server` host-server (sandbox per session) |
| Auth | loopback PKCE + safeStorage | browser redirect PKCE + localStorage |
| Model calls | renderer → Openference direct | renderer → `/api` proxy → Openference |

## Run locally

```bash
# 1. OAuth provider (issues tokens)
pnpm oauth:dev                       # http://localhost:8788

# 2. Host-server (WebSocket + model proxy)
DEYIN_OAUTH_ISSUER=http://localhost:8788 pnpm --filter @deyin/web dev:server

# 3. Web client
pnpm --filter @deyin/web dev         # http://localhost:5273
```

The dev client is registered as a redirect URI (`http://localhost:5273/auth/callback`) on
the seeded `deyin-desktop` client, so "Connect with Openference" works end to end.

## Production shape

- Static client behind a CDN.
- Host-server behind a WebSocket-aware proxy; **one sandboxed container per authenticated
  session**, with `SessionHost` bound to that container's workspace volume.
- The `/api` proxy centralizes the Openference Bearer token and keeps the browser off
  cross-origin model calls.
- An idle reaper tears down sessions after inactivity.
