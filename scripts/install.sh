#!/usr/bin/env bash
# Deyin CLI installer: downloads the latest single-file binary from GitHub Releases.
#
#   curl -fsSL https://cdn.deyin.dev/cli/install.sh | bash
#
# Overrides:
#   DEYIN_RELEASES_REPO  GitHub repo hosting the releases (default deyin-dev/deyin-desktop)
#   DEYIN_INSTALL_DIR    Install directory (default ~/.local/bin)
#   DEYIN_VERSION        Tag to install, e.g. v0.2.0 (default: latest)
set -euo pipefail

REPO="${DEYIN_RELEASES_REPO:-deyin-dev/deyin-desktop}"
INSTALL_DIR="${DEYIN_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${DEYIN_VERSION:-latest}"

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  *)
    echo "error: unsupported OS $(uname -s). On Windows, use: npm install -g @deyin/cli" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH="x64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
  *)
    echo "error: unsupported architecture $(uname -m)." >&2
    exit 1
    ;;
esac

ASSET="deyin-${OS}-${ARCH}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
fi

echo "Downloading ${URL}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
curl -fL --progress-bar -o "$TMP" "$URL"
chmod +x "$TMP"

mkdir -p "$INSTALL_DIR"
mv "$TMP" "$INSTALL_DIR/deyin"
trap - EXIT

echo "Installed deyin to $INSTALL_DIR/deyin"
"$INSTALL_DIR/deyin" --version

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "Note: $INSTALL_DIR is not in your PATH. Add this to your shell profile:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo ""
echo "Get started:"
echo "  deyin login    # sign in with Openference"
echo "  deyin          # open the TUI"
