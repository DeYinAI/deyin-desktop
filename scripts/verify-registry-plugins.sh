#!/usr/bin/env bash
# Verify DeYinAI/registry plugins load through @deyin/agent-core discovery.
set -euo pipefail

cd "$(dirname "$0")/.."

REGISTRY_ROOT="${REGISTRY_ROOT:-$(cd .. && pwd)/registry}"

if [[ ! -f "${REGISTRY_ROOT}/registry.json" ]]; then
  echo "==> Registry not found at ${REGISTRY_ROOT}; skipping plugin verification."
  echo "    Set REGISTRY_ROOT to the DeYinAI/registry checkout to enable."
  exit 0
fi

echo "==> Verifying registry plugins from ${REGISTRY_ROOT}"
pnpm --filter @deyin/agent-core build
node scripts/verify-registry-plugins.mjs
