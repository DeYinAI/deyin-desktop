# Deploying Deyin web to chat.openference.com

Replaces the legacy `chat-openference` Cloudflare Worker with the Deyin web stack:
static SPA + Node host-server (WebSocket agent loop, file tools, model proxy).

## Architecture

| Path | Handler |
| --- | --- |
| `/`, `/auth/callback`, assets | Static SPA (`dist/client`) via Caddy |
| `/api/*` | Host-server → `api.openference.com/v1` |
| `/host` (WebSocket) | Host-server session (files, terminal, agent) |
| `/health` | Host-server liveness |

Auth: OAuth 2.0 + PKCE via `openference.com` (`deyin-web` client).

## 1. Openference OAuth (one-time)

Apply migration `0321_oauth_deyin_web_chat_redirect` on the Openference worker (`glm` repo).
It registers:

```
https://chat.openference.com/auth/callback
```

on the `deyin-web` OAuth client.

Smoke test after deploy:

```bash
curl -s https://openference.com/.well-known/openid-configuration | jq .issuer
```

## 2. Build

```bash
cd deyin-desktop
pnpm install

export VITE_DEYIN_OAUTH_ISSUER=https://openference.com
export VITE_DEYIN_CLIENT_ID=deyin-web

pnpm --filter @deyin/web... build
```

Outputs:

- `apps/web/dist/client/` — static SPA
- `apps/web/dist/server/index.js` — host-server

See [`.env.production.example`](./.env.production.example) for all env vars.

## 3. Run locally (docker compose)

```bash
cd apps/web
docker compose up --build
# → http://localhost:8080
```

Requires a prior `pnpm --filter @deyin/web... build` so `./dist/client` exists for Caddy.

## 4. Production (VPS + systemd + Caddy)

### Host-server env

Create `/etc/deyin/web.env`:

```env
DEYIN_OAUTH_ISSUER=https://openference.com
DEYIN_API_BASE_URL=https://api.openference.com/v1
PORT=8790
```

Install systemd unit from [`deploy/deyin-web.service`](./deploy/deyin-web.service):

```bash
sudo cp deploy/deyin-web.service /etc/systemd/system/
sudo systemctl enable --now deyin-web
```

Or use the deploy script:

```bash
DEPLOY_HOST=user@your-vps ./deploy/deploy.sh
```

### Caddy

Copy [`Caddyfile`](./Caddyfile) to your server (e.g. `/etc/caddy/Caddyfile.d/deyin.caddy`)
and set the static root to your deployed client path:

```
root * /opt/deyin/web/dist/client
```

Reload Caddy: `sudo systemctl reload caddy`

### Cloudflare Tunnel (optional)

If the domain stays on Cloudflare, run `cloudflared tunnel` to Caddy on `:443` instead of
opening VPS ports. WebSockets must pass through the tunnel.

## 5. DNS cutover from legacy Worker

The old app uses a Cloudflare Worker custom domain in `chat-openference/wrangler.jsonc`.

1. Deploy and smoke-test Deyin on a staging host or `localhost:8080`.
2. Remove the Worker route (edit `wrangler.jsonc`, redeploy, or delete custom domain in CF dashboard).
3. Point `chat.openference.com` DNS to the new host (A record or Tunnel).

## 6. Smoke checklist

```bash
curl -I https://chat.openference.com/
curl -s https://chat.openference.com/health
```

In browser:

1. Open `https://chat.openference.com`
2. Click **Connect with Openference**
3. Complete OAuth (should auto-approve if already signed in on openference.com)
4. Confirm `localStorage` has `deyin.tokens`
5. Confirm WebSocket to `wss://chat.openference.com/host` in Network tab
6. Send a chat message (streams via `/api/v1/chat/completions`)

## 7. Retire legacy chat-openference

Do **not** copy deyin files into `chat-openference`. Archive that repo or branch
`legacy/pre-deyin`. D1 conversation history does not migrate automatically.

## Chat-only on Cloudflare (recommended for chat.openference.com)

For **Deyin UI + plain chat only** (no agent host-server), see **[DEPLOY-CHAT.md](./DEPLOY-CHAT.md)**.

Build flag: `VITE_DEYIN_CHAT_ONLY=true` — skips WebSocket host, forces chat mode, deploys via `wrangler.chat.jsonc` (~$5/mo).

---

## Production follow-ups

- Per-session containers instead of temp dirs (`session.ts` uses `mkdtemp` today)
- Idle session reaper
- CI deploy on tag push
