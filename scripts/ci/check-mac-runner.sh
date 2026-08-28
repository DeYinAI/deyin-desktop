#!/usr/bin/env bash
# Verify self-hosted macOS runner has tools needed for release packaging.
set -euo pipefail

missing=0

require_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "ok  $1 ($("$1" --version 2>&1 | head -1))"
  else
    echo "MISSING  $1 — run: bash scripts/ci/setup-mac-runner.sh"
    missing=1
  fi
}

# GitHub-hosted macOS runners include Node via actions/setup-node; bun via setup-bun.
# Self-hosted mac-runner: run setup-mac-runner.sh once on the Mac host.
export PATH="${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

echo "==> macOS runner prerequisites"
require_cmd node
require_cmd pnpm
require_cmd git
require_cmd bun

if ! xcode-select -p >/dev/null 2>&1; then
  echo "MISSING  Xcode Command Line Tools — run: xcode-select --install"
  missing=1
else
  echo "ok  Xcode Command Line Tools"
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this script must run on macOS (Darwin)" >&2
  exit 1
fi

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

echo "==> All prerequisites present."
