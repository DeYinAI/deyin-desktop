#!/usr/bin/env bash
# Verify self-hosted Dell runner has tools needed for CI + cross-platform release builds.
set -euo pipefail

missing=0

require_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "ok  $1 ($("$1" --version 2>&1 | head -1))"
  else
    echo "MISSING  $1 — run: bash scripts/ci/setup-dell-runner.sh"
    missing=1
  fi
}

# User-level dotnet install (setup-dell-runner.sh without sudo).
export PATH="${HOME}/.dotnet:${PATH}"

echo "==> Dell runner prerequisites"
require_cmd node
require_cmd pnpm
require_cmd git
require_cmd wine
require_cmd dotnet
require_cmd bun

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

echo "==> All prerequisites present."
