# Deyin UI — chat-only on Cloudflare

Hosted **Deyin look-and-feel** at `chat.openference.com` with **plain chat only** (no agent, terminal, git, or host-server). Full coding agent stays in the **desktop app**.

## What runs where

```
Browser
  ├── Static SPA (Deyin UI, VITE_DEYIN_CHAT_ONLY=true)
  ├── OAuth → openference.com (deyin-web client)
  └── POST /api/v1/chat/completions → Worker proxy → api.openference.com
```

No WebSocket. No Containers. No VPS.

## Build

```bash
cd deyin-desktop

export VITE_DEYIN_OAUTH_ISSUER=https://openference.com
export VITE_DEYIN_CLIENT_ID=deyin-web
export VITE_DEYIN_CHAT_ONLY=true

pnpm --filter @deyin/web build:chat
```

## Deploy

1. Apply Openference migration `0321_oauth_deyin_web_chat_redirect` (OAuth callback for `deyin-web`).
2. Remove the legacy `chat-openference` Worker route from `chat.openference.com` (one domain, one Worker).
3. Deploy:

```bash
cd apps/web
pnpm deploy:chat
```

## Local dev (chat-only)

```bash
export VITE_DEYIN_OAUTH_ISSUER=http://localhost:8788
export VITE_DEYIN_CLIENT_ID=deyin-web
export VITE_DEYIN_CHAT_ONLY=true
pnpm --filter @deyin/web dev
```

Use `pnpm oauth:dev` for local OAuth if testing sign-in.

## What's disabled on web (chat-only)

| Feature | Web chat-only | Desktop |
|---|---|---|
| Plain chat + models | Yes | Yes |
| Agent / tools / terminal | No | Yes |
| Git / repo connect | No | Yes |
| Side workspace panel | Hidden | Yes |

Users see a banner linking to the desktop app for full agent features.

## Cost

~**$5/month** Workers Paid (SPA + light API proxy). LLM usage billed via Openference separately.
