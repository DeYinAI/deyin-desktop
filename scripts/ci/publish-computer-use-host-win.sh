#!/usr/bin/env bash
# Cross-publish the Windows computer-use-host sidecar from Linux (CI / dell-runner).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="${ROOT}/native/computer-use-host/native/deyin-computer-use-host.csproj"
OUT="${ROOT}/native/computer-use-host/native/bin/Release/net8.0-windows/win-x64/publish"

export PATH="${HOME}/.dotnet:${PATH}"

if ! command -v dotnet >/dev/null 2>&1; then
  echo "error: dotnet SDK required. Run: sudo bash scripts/ci/setup-dell-runner.sh" >&2
  exit 1
fi

echo "==> Publishing computer-use-host for win-x64"
dotnet publish "$PROJECT" \
  -c Release \
  -r win-x64 \
  --self-contained true \
  -o "$OUT"

test -f "${OUT}/deyin-computer-use-host.exe"
echo "==> Published ${OUT}/deyin-computer-use-host.exe"
