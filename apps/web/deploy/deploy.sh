#!/usr/bin/env bash
# Deploy Deyin web to a VPS (systemd + Caddy on the host).
#
# Usage:
#   DEPLOY_HOST=user@your-server ./deploy/deploy.sh
#
# Prerequisites on the server:
#   - Node 20+, git, Caddy 2, systemd
#   - /etc/deyin/web.env (copy from apps/web/.env.production.example)
#   - Caddyfile installed (copy apps/web/Caddyfile → /etc/caddy/Caddyfile.d/deyin.caddy)
#
# OAuth: migration 0321_oauth_deyin_web_chat_redirect must be applied on openference.com
# before production login will work.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB="$ROOT/apps/web"
DEPLOY_HOST="${DEPLOY_HOST:-}"
REMOTE_DIR="${REMOTE_DIR:-/opt/deyin/web}"

if [[ -z "$DEPLOY_HOST" ]]; then
  echo "Set DEPLOY_HOST=user@server" >&2
  exit 1
fi

export VITE_DEYIN_OAUTH_ISSUER="${VITE_DEYIN_OAUTH_ISSUER:-https://openference.com}"
export VITE_DEYIN_CLIENT_ID="${VITE_DEYIN_CLIENT_ID:-deyin-web}"

echo "==> Building @deyin/web..."
cd "$ROOT"
pnpm install --frozen-lockfile
pnpm --filter @deyin/web... build

echo "==> Syncing to $DEPLOY_HOST:$REMOTE_DIR..."
ssh "$DEPLOY_HOST" "sudo mkdir -p '$REMOTE_DIR' && sudo chown -R \$(whoami) '$REMOTE_DIR'"
rsync -avz --delete \
  "$WEB/dist/" "$DEPLOY_HOST:$REMOTE_DIR/dist/"
rsync -avz \
  "$WEB/deploy/deyin-web.service" "$DEPLOY_HOST:/tmp/deyin-web.service"

echo "==> Installing systemd unit + restarting..."
ssh "$DEPLOY_HOST" "sudo mv /tmp/deyin-web.service /etc/systemd/system/deyin-web.service && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable deyin-web && \
  sudo systemctl restart deyin-web && \
  sudo systemctl status deyin-web --no-pager"

echo "==> Done. Ensure Caddy serves $REMOTE_DIR/dist/client and proxies /api + /host to :8790."
echo "    Health: curl -s http://127.0.0.1:8790/health"
