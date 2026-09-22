#!/usr/bin/env bash
# Cross-publish the Windows computer-use-host sidecar from Linux (CI / dell-runner).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="${ROOT}/native/computer-use-host/native/deyin-computer-use-host.csproj"
OUT="${ROOT}/native/computer-use-host/native/bin/Release/net8.0-windows/win-x64/publish"

export PATH="${HOME}/.dotnet:${PATH}"

if command -v dotnet >/dev/null 2>&1; then
  DOTNET_CMD="dotnet"
elif [ -f "/mnt/c/Program Files/dotnet/dotnet.exe" ]; then
  DOTNET_CMD="/mnt/c/Program Files/dotnet/dotnet.exe"
elif command -v dotnet.exe >/dev/null 2>&1; then
  DOTNET_CMD="dotnet.exe"
else
  echo "error: dotnet SDK required. Run: sudo bash scripts/ci/setup-dell-runner.sh" >&2
  exit 1
fi

echo "==> Publishing computer-use-host for win-x64 using $DOTNET_CMD"
if [[ "$DOTNET_CMD" == *".exe"* ]]; then
  WIN_PROJ="$(wslpath -w "$PROJECT")"
  WIN_OUT="$(wslpath -w "$OUT")"
  "$DOTNET_CMD" publish "$WIN_PROJ" \
    -c Release \
    -r win-x64 \
    --self-contained true \
    -o "$WIN_OUT"
else
  "$DOTNET_CMD" publish "$PROJECT" \
    -c Release \
    -r win-x64 \
    --self-contained true \
    -o "$OUT"
fi

test -f "${OUT}/deyin-computer-use-host.exe"
echo "==> Published ${OUT}/deyin-computer-use-host.exe"
