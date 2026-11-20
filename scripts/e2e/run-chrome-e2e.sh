#!/usr/bin/env bash
# Run the Chrome extension end-to-end harness against real Windows Chrome from WSL.
#
# Bundles the real host code with esbuild, copies it plus the extension and the
# `ws` package to a Windows folder, and runs it with the Windows node.exe (the
# relay must live on the Windows side because WSL cannot reach Windows loopback).
# Starts only its own throwaway-profile Chrome; the user's browser is never touched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT=/mnt/c/tmp/deyin-e2e
WIN_OUT='C:\tmp\deyin-e2e'
NODE="/mnt/c/Program Files/nodejs/node.exe"

rm -rf "$OUT/extension" "$OUT/host.mjs"
mkdir -p "$OUT/node_modules"

cd "$ROOT"
# esbuild is not hoisted; resolve it through tsx, which depends on it.
ESBUILD="$(node -e "const p=require('path');const t=require.resolve('tsx/package.json',{paths:['$ROOT']});console.log(require.resolve('esbuild/bin/esbuild',{paths:[p.dirname(t)]}))")"
"$ESBUILD" scripts/e2e/host-entry.ts --bundle --platform=node --format=esm --external:ws --outfile="$OUT/host.mjs" --log-level=warning

WS_DIR="$(dirname "$(node -e "console.log(require.resolve('ws/package.json', { paths: ['$ROOT/apps/desktop'] }))")")"
rsync -a --delete "$WS_DIR/" "$OUT/node_modules/ws/"
rsync -a --delete apps/desktop/bundled-plugins/chrome/extension/ "$OUT/extension/"
cp scripts/e2e/chrome-extension-e2e.mjs "$OUT/chrome-extension-e2e.mjs"
echo '{"type":"module"}' > "$OUT/package.json"

cd "$OUT"
"$NODE" "$WIN_OUT\\chrome-extension-e2e.mjs"
