#!/usr/bin/env bash
# One-time (idempotent) setup for a self-hosted macOS release runner (mac-runner).
# Installs Node 22, pnpm, and Bun for desktop packaging + CLI cross-compile.
#
# Run on the Mac that will register as mac-runner:
#   bash scripts/ci/setup-mac-runner.sh
set -euo pipefail

export PATH="${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

install_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    echo "ok  brew ($(brew --version | head -1))"
    return
  fi
  echo "==> Installing Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

install_node() {
  if command -v node >/dev/null 2>&1 && node -v | grep -q '^v22\.'; then
    echo "ok  node ($(node -v))"
    return
  fi
  echo "==> Installing Node 22 via Homebrew"
  brew install node@22
  brew link --overwrite --force node@22 2>/dev/null || true
}

install_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    echo "ok  pnpm ($(pnpm --version))"
    return
  fi
  echo "==> Installing pnpm"
  corepack enable
  corepack prepare pnpm@10 --activate
}

install_bun() {
  if command -v bun >/dev/null 2>&1; then
    echo "ok  bun ($(bun --version))"
    return
  fi
  echo "==> Installing Bun"
  curl -fsSL https://bun.sh/install | bash
}

check_xcode_clt() {
  if xcode-select -p >/dev/null 2>&1; then
    echo "ok  Xcode Command Line Tools"
  else
    echo "MISSING  Xcode Command Line Tools — run: xcode-select --install"
    return 1
  fi
}

echo "==> macOS release runner setup ($(sw_vers -productVersion))"
install_homebrew
install_node
install_pnpm
install_bun
check_xcode_clt

echo "==> Done. Verify with: bash scripts/ci/check-mac-runner.sh"
