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
export PATH="${HOME}/.dotnet:${HOME}/.bun/bin:/usr/local/bin:${PATH}"

echo "==> Dell runner prerequisites"
require_cmd node
require_cmd pnpm
require_cmd git
require_cmd wine
require_cmd dotnet
require_cmd bun
require_cmd xvfb-run

if ! dpkg -s wine32 >/dev/null 2>&1; then
  echo "MISSING  wine32 (i386) — run: sudo bash scripts/ci/setup-dell-runner.sh"
  missing=1
fi

# Microsoft SDK (not Ubuntu apt dotnet) is required for net8.0-windows cross-publish.
if ! dotnet --list-sdks 2>/dev/null | grep -q .; then
  echo "MISSING  dotnet SDK — run: bash scripts/ci/setup-dell-runner.sh"
  missing=1
fi
WINE_DESKTOP="$(find "${HOME}/.dotnet/sdk" -maxdepth 3 -type d -name Microsoft.NET.Sdk.WindowsDesktop 2>/dev/null | head -1 || true)"
if [[ -z "$WINE_DESKTOP" ]]; then
  WINE_DESKTOP="$(find /usr/lib/dotnet/sdk -maxdepth 3 -type d -name Microsoft.NET.Sdk.WindowsDesktop 2>/dev/null | head -1 || true)"
fi
if [[ -z "$WINE_DESKTOP" ]]; then
  echo "MISSING  Microsoft.NET.Sdk.WindowsDesktop — install Microsoft dotnet to \${HOME}/.dotnet"
  missing=1
fi

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

echo "==> All prerequisites present."
