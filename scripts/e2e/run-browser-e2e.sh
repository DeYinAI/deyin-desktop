#!/usr/bin/env bash
# Run the in-app browser tools against a real Electron <webview> (hidden window,
# throwaway userData, local fixture server). Works on Linux/WSLg; pass nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${TMPDIR:-/tmp}/deyin-browser-e2e"
ELECTRON="$ROOT/apps/desktop/node_modules/electron/dist/electron"

rm -rf "$OUT"
mkdir -p "$OUT"

cd "$ROOT"
# esbuild is not hoisted; resolve it through tsx, which depends on it.
ESBUILD="$(node -e "const p=require('path');const t=require.resolve('tsx/package.json',{paths:['$ROOT']});console.log(require.resolve('esbuild/bin/esbuild',{paths:[p.dirname(t)]}))")"
"$ESBUILD" scripts/e2e/browser-entry.ts --bundle --platform=node --format=cjs --external:electron --outfile="$OUT/service.cjs" --log-level=warning
cp scripts/e2e/browser-electron-e2e.cjs "$OUT/main.cjs"

set +e
SHOW="${SHOW:-0}" "$ELECTRON" "$OUT/main.cjs" --no-sandbox --disable-gpu > "$OUT/log.txt" 2>&1
code=$?
set -e
# dbus/GPU noise on WSLg is harmless; show only the harness lines.
rg -v "dbus|Gtk|GLib|ERROR:(bus|viz|gpu|command_buffer)|Fontconfig|libva|vaapi|Exiting GPU" "$OUT/log.txt" || true
exit "$code"
