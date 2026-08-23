#!/usr/bin/env bash
# One-time (idempotent) setup for the self-hosted Linux runner (dell-runner).
# Installs Wine (Windows NSIS cross-build) and .NET 8 SDK (computer-use-host).
#
# With sudo (runner host):  sudo bash scripts/ci/setup-dell-runner.sh
# Without sudo (user):      bash scripts/ci/setup-dell-runner.sh
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export PATH="${HOME}/.dotnet:${PATH}"

install_dotnet_microsoft() {
  local user_home="${1:-${HOME}}"
  local install_dir="${user_home}/.dotnet"
  if [[ -f "${install_dir}/dotnet" ]] && [[ -d "${install_dir}/sdk"/*/Sdks/Microsoft.NET.Sdk.WindowsDesktop ]]; then
    echo "    Microsoft .NET SDK ok: $("${install_dir}/dotnet" --version)"
    return
  fi
  echo "    Installing Microsoft .NET 8 SDK to ${install_dir} (Ubuntu apt dotnet lacks Windows cross-targets)"
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
  bash /tmp/dotnet-install.sh --channel 8.0 --install-dir "${install_dir}"
  if [[ "$(id -u)" -eq 0 ]] && [[ -n "${SUDO_USER:-}" ]]; then
    chown -R "${SUDO_USER}:${SUDO_USER}" "${install_dir}"
  fi
  ln -sf "${install_dir}/dotnet" /usr/local/bin/dotnet 2>/dev/null || true
}

install_dotnet_user() {
  install_dotnet_microsoft "${HOME}"
  grep -q '.dotnet' "${HOME}/.bashrc" 2>/dev/null || echo 'export PATH="${HOME}/.dotnet:${PATH}"' >> "${HOME}/.bashrc"
}

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "==> User-level setup (no sudo)"
  install_dotnet_user
  if ! command -v bun >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
  fi
  echo "==> Wine requires sudo on Ubuntu — if missing, run: sudo apt install -y wine64"
  command -v wine >/dev/null 2>&1 && echo "ok  wine ($(wine --version 2>&1 | head -1))" || echo "MISSING wine (needs sudo apt install)"
  echo "==> Done. Verify: bash scripts/ci/check-dell-runner.sh"
  exit 0
fi

echo "==> apt update"
apt-get update -y

echo "==> Wine (NSIS / electron-builder --win on Linux)"
if command -v wine >/dev/null 2>&1; then
  echo "    wine already installed: $(wine --version 2>&1 | head -1)"
else
  dpkg --add-architecture i386 2>/dev/null || true
  apt-get install -y wine64 wine32 winbind || apt-get install -y wine winbind
fi

echo "==> .NET 8 SDK (computer-use-host win-x64 cross-publish)"
RUNNER_USER="${SUDO_USER:-${USER}}"
RUNNER_HOME="$(getent passwd "${RUNNER_USER}" | cut -d: -f6)"
install_dotnet_microsoft "${RUNNER_HOME}"

echo "==> Bun (CLI release cross-compile)"
if command -v bun >/dev/null 2>&1; then
  echo "    bun already installed: $(bun --version)"
else
  curl -fsSL https://bun.sh/install | bash
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun 2>/dev/null || true
fi

echo "==> Done. Verify with: bash scripts/ci/check-dell-runner.sh"
