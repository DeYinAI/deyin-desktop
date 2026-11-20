#!/usr/bin/env bash
# Run the computer-use end-to-end harness against the real C# host on Windows, from WSL.
#
# Builds the host and the WinForms fixture with the Windows dotnet, bundles the real TypeScript pipe client with
# esbuild, then runs the harness with the Windows node.exe. It opens its own fixture windows (titled
# "DeyinE2E ...") and a throwaway-profile Chrome, and closes them by pid. The user's windows are not touched.
set -euo pipefail

# Two runs at once fight over the foreground window and the fixtures' shared titles, and every check fails.
exec 9>/tmp/deyin-cu-e2e.lock
if ! flock -n 9; then
  echo "another computer-use E2E run is already in progress; wait for it to finish" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT=/mnt/c/tmp/deyin-cu-e2e
WIN_OUT='C:\tmp\deyin-cu-e2e'
NODE="/mnt/c/Program Files/nodejs/node.exe"
HOST_SRC="$ROOT/native/computer-use-host"

echo "== build host"
mkdir -p /mnt/c/tmp/deyin-cuh /mnt/c/tmp/deyin-testapp
rsync -a --delete --exclude bin --exclude obj "$HOST_SRC/native/" /mnt/c/tmp/deyin-cuh/
dotnet.exe build -c Release 'C:\tmp\deyin-cuh\deyin-computer-use-host.csproj' -nologo -v q 2>&1 | sed 's/\[C:.*//' | grep -E "error|warning|Build succeeded" | sort -u

echo "== build fixture"
rsync -a --delete --exclude bin --exclude obj "$HOST_SRC/test-app/" /mnt/c/tmp/deyin-testapp/
dotnet.exe build -c Release 'C:\tmp\deyin-testapp\DeyinTestApp.csproj' -nologo -v q 2>&1 | sed 's/\[C:.*//' | grep -E "error|warning|Build succeeded" | sort -u

echo "== bundle client"
mkdir -p "$OUT"
cd "$ROOT"
ESBUILD="$(node -e "const p=require('path');const t=require.resolve('tsx/package.json',{paths:['$ROOT']});console.log(require.resolve('esbuild/bin/esbuild',{paths:[p.dirname(t)]}))")"
"$ESBUILD" scripts/e2e/computer-use-entry.ts --bundle --platform=node --format=esm --outfile="$OUT/host.mjs" --log-level=warning
cp scripts/e2e/computer-use-e2e.mjs "$OUT/computer-use-e2e.mjs"
echo '{"type":"module"}' > "$OUT/package.json"
rm -rf "$OUT/work"

echo "== run"
cd "$OUT"
"$NODE" "$WIN_OUT\\computer-use-e2e.mjs"
