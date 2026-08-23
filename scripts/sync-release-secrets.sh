#!/usr/bin/env bash
# Push release/signing secrets from a local gitignored file to GitHub Actions.
# Usage:
#   cp .env.release.local.example .env.release.local
#   # edit .env.release.local with real values
#   bash scripts/sync-release-secrets.sh
#
# Never commit .env.release.local or certificate files.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env.release.local"
REPO="${GITHUB_REPO:-DeYinAI/deyin-desktop}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing ${ENV_FILE}"
  echo "Copy .env.release.local.example and fill in your values first."
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

SECRETS=(
  RELEASES_TOKEN
  CSC_LINK
  CSC_KEY_PASSWORD
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  APPLE_TEAM_ID
  WIN_CSC_LINK
  WIN_CSC_KEY_PASSWORD
)

synced=0
skipped=0

for name in "${SECRETS[@]}"; do
  value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "skip ${name} (empty)"
    ((skipped++)) || true
    continue
  fi
  printf '%s' "$value" | gh secret set "$name" --repo "$REPO"
  echo "set ${name}"
  ((synced++)) || true
done

echo ""
echo "Done: ${synced} secret(s) synced, ${skipped} skipped."
echo "Verify: gh secret list --repo ${REPO}"
