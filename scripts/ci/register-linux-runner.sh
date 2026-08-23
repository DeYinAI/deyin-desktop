#!/usr/bin/env bash
# Register a new self-hosted Linux runner for DeYinAI/deyin-desktop.
#
# Prerequisites on this host:
#   bash scripts/ci/setup-dell-runner.sh   # release-capable (Wine, .NET, Bun)
#   bash scripts/ci/check-dell-runner.sh     # optional; required for release label
#
# Usage:
#   # CI-only runner (verify + AI review; no Wine needed):
#   RUNNER_NAME=wsl-ci-1 RUNNER_LABELS=ci bash scripts/ci/register-linux-runner.sh
#
#   # Full release runner (same toolchain as dell-runner):
#   RUNNER_NAME=dell-runner-2 RUNNER_LABELS=ci,release bash scripts/ci/register-linux-runner.sh
#
# Token: export RUNNER_TOKEN=... from GitHub → Settings → Actions → Runners → New runner,
#   or:  RUNNER_TOKEN=$(gh api repos/DeYinAI/deyin-desktop/actions/runners/registration-token --jq .token)
#        (requires repo admin)
set -euo pipefail

REPO="${RUNNER_REPO:-DeYinAI/deyin-desktop}"
RUNNER_NAME="${RUNNER_NAME:-}"
RUNNER_LABELS="${RUNNER_LABELS:-}"
RUNNER_DIR="${RUNNER_DIR:-${HOME}/actions-runner}"
RUNNER_VERSION="${RUNNER_VERSION:-2.336.0}"

if [[ -z "${RUNNER_NAME}" ]]; then
  echo "error: set RUNNER_NAME (e.g. wsl-ci-1 or dell-runner-2)" >&2
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

if [[ "${RUNNER_LABELS}" == *release* ]] || [[ -z "${RUNNER_LABELS}" ]]; then
  echo "==> Checking release toolchain (Wine, .NET, Bun)"
  bash "$(dirname "$0")/check-dell-runner.sh"
fi

ARCH="x64"
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "error: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

TARBALL="actions-runner-linux-${ARCH}-${RUNNER_VERSION}.tar.gz"
URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"

mkdir -p "${RUNNER_DIR}"
cd "${RUNNER_DIR}"

if [[ ! -f ./config.sh ]]; then
  echo "==> Downloading actions-runner v${RUNNER_VERSION}"
  curl -fsSL -o "${TARBALL}" "${URL}"
  tar xzf "${TARBALL}"
  rm -f "${TARBALL}"
fi

# GitHub merges custom labels with the read-only self-hosted / OS / arch labels.
LABEL_ARG="self-hosted,Linux,X64"
if [[ -n "${RUNNER_LABELS}" ]]; then
  LABEL_ARG="${LABEL_ARG},${RUNNER_LABELS}"
fi

echo "==> Configuring ${RUNNER_NAME} (${LABEL_ARG})"
./config.sh \
  --url "https://github.com/${REPO}" \
  --token "${RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "${LABEL_ARG}" \
  --unattended \
  --replace

echo "==> Installing and starting service (may prompt for sudo)"
if [[ -f ./svc.sh ]]; then
  sudo ./svc.sh install
  sudo ./svc.sh start
  sudo ./svc.sh status || true
else
  echo "    Run manually: ./run.sh"
fi

echo "==> Registered ${RUNNER_NAME}. Confirm in GitHub → Settings → Actions → Runners."
