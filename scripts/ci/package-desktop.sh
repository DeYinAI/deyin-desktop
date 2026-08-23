#!/usr/bin/env bash
# Package Deyin desktop installers on the Dell Linux runner.
# Usage: bash scripts/ci/package-desktop.sh [linux|win|all]
set -euo pipefail

TARGET="${1:-all}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

CONFIG="electron-builder.yml"

build_vite() {
  echo "==> electron-vite build"
  pnpm --filter @deyin/desktop run build
}

package_linux() {
  echo "==> Packaging Linux (AppImage + deb)"
  pnpm --filter @deyin/desktop exec electron-builder \
    --linux \
    --publish never \
    --config "$CONFIG"
}

package_win() {
  if ! command -v wine >/dev/null 2>&1; then
    echo "error: wine required for Windows NSIS on Linux" >&2
    exit 1
  fi
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "error: xvfb-run required for headless Wine (rcedit / NSIS on CI)" >&2
    exit 1
  fi
  export PATH="${HOME}/.dotnet:${HOME}/.bun/bin:${PATH}"
  bash scripts/ci/publish-computer-use-host-win.sh
  echo "==> Packaging Windows (NSIS exe) under xvfb-run"
  # electron-builder invokes Wine for rcedit on Linux; dell-runner has no display.
  xvfb-run -a pnpm --filter @deyin/desktop exec electron-builder \
    --win \
    --x64 \
    --publish never \
    --config "$CONFIG"
}

echo "==> Generate app icons"
pnpm --filter @deyin/branding make-icons

build_vite

case "$TARGET" in
  linux) package_linux ;;
  win) package_win ;;
  all)
    package_linux
    package_win
    ;;
  *)
    echo "usage: $0 [linux|win|all]" >&2
    exit 1
    ;;
esac

echo "==> Artifacts in apps/desktop/release/"
ls -la apps/desktop/release/ 2>/dev/null || true
