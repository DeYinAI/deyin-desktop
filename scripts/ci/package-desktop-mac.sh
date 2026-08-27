#!/usr/bin/env bash
# Package Deyin desktop macOS DMG(s) on a macOS host (mac-runner).
# Usage: bash scripts/ci/package-desktop-mac.sh [arm64|x64|both]
set -euo pipefail

TARGET="${1:-both}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: macOS DMG builds require a Mac (electron-builder cannot cross-compile mac from Linux)" >&2
  exit 1
fi

CONFIG="electron-builder.yml"

build_vite() {
  echo "==> electron-vite build"
  pnpm --filter @deyin/desktop run build
}

package_mac() {
  local arch_flags=()
  case "$TARGET" in
    arm64) arch_flags=(--arm64) ;;
    x64) arch_flags=(--x64) ;;
    both) arch_flags=(--arm64 --x64) ;;
    *)
      echo "usage: $0 [arm64|x64|both]" >&2
      exit 1
      ;;
  esac
  echo "==> Packaging macOS DMG (${TARGET})"
  pnpm --filter @deyin/desktop exec electron-builder \
    --mac \
    "${arch_flags[@]}" \
    --publish never \
    --config "$CONFIG"
}

echo "==> Generate app icons"
pnpm --filter @deyin/branding make-icons

build_vite
package_mac

echo "==> Artifacts in apps/desktop/release/"
ls -la apps/desktop/release/*.dmg 2>/dev/null || ls -la apps/desktop/release/ 2>/dev/null || true
