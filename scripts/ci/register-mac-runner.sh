#!/usr/bin/env bash
# Register a self-hosted macOS runner for DeYinAI/deyin-desktop release builds.
#
# Prerequisites on this Mac:
#   bash scripts/ci/setup-mac-runner.sh
#   bash scripts/ci/check-mac-runner.sh
#
# Usage:
#   RUNNER_NAME=mac-runner bash scripts/ci/register-mac-runner.sh
#
# Token: export RUNNER_TOKEN=... from GitHub → Settings → Actions → Runners → New runner,
#   or:  RUNNER_TOKEN=$(gh api repos/DeYinAI/deyin-desktop/actions/runners/registration-token --jq .token)
set -euo pipefail

REPO="${RUNNER_REPO:-DeYinAI/deyin-desktop}"
RUNNER_NAME="${RUNNER_NAME:-mac-runner}"
RUNNER_DIR="${RUNNER_DIR:-${HOME}/actions-runner}"
RUNNER_VERSION="${RUNNER_VERSION:-2.336.0}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: macOS runner registration must run on a Mac" >&2
  exit 1
fi

if [[ -z "${RUNNER_TOKEN:-}" ]]; then
  if command -v gh >/dev/null 2>&1; then
    echo "==> Fetching registration token via gh"
    RUNNER_TOKEN="$(gh api "repos/${REPO}/actions/runners/registration-token" --jq .token 2>/dev/null || true)"
  fi
fi
if [[ -z "${RUNNER_TOKEN:-}" ]]; then
  echo "error: export RUNNER_TOKEN from GitHub → Settings → Actions → Runners → New self-hosted runner" >&2
  exit 1
fi

echo "==> Checking macOS release toolchain"
bash "$(dirname "$0")/check-mac-runner.sh"

ARCH="x64"
case "$(uname -m)" in
  x86_64) ARCH="x64" ;;
  arm64) ARCH="arm64" ;;
  *) echo "error: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

TARBALL="actions-runner-osx-${ARCH}-${RUNNER_VERSION}.tar.gz"
URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"

mkdir -p "${RUNNER_DIR}"
cd "${RUNNER_DIR}"

if [[ ! -f ./config.sh ]]; then
  echo "==> Downloading actions-runner v${RUNNER_VERSION}"
  curl -fsSL -o "${TARBALL}" "${URL}"
  tar xzf "${TARBALL}"
  rm -f "${TARBALL}"
fi

# Custom release-mac label lets release.yml target mac packaging without matching arch.
LABEL_ARG="self-hosted,macOS,${ARCH},release-mac"

echo "==> Configuring ${RUNNER_NAME} (${LABEL_ARG})"
./config.sh \
  --url "https://github.com/${REPO}" \
  --token "${RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "${LABEL_ARG}" \
  --unattended \
  --replace

echo "==> Installing launchd service (may prompt for password)"
if [[ -f ./svc.sh ]]; then
  ./svc.sh install
  ./svc.sh start
  ./svc.sh status || true
else
  echo "    Run manually: ./run.sh"
fi

echo "==> Registered ${RUNNER_NAME}. Confirm in GitHub → Settings → Actions → Runners."
