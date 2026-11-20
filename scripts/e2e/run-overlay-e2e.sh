#!/usr/bin/env bash
# Show the real computer-use overlay in a real Windows Electron, from WSL, and check what Windows reports about it:
# click-through border, non-activating clickable pill, hidden from capture and from the agent's window list.
#
# The overlay flashes on the desktop for about 15 seconds. It runs in its own throwaway Electron profile and never
# touches an installed Deyin or any other window. Needs a Windows Electron of the same version as apps/desktop in
# C:\tmp\deyin-overlay-e2e (see below) and the host built by run-computer-use-e2e.sh.
#
#   SHOW_MS=30000 NO_PROTECT=1 ./scripts/e2e/run-overlay-e2e.sh
#
# holds the loud states for 30 s each, with capture exclusion off in that one process, so a screenshot can see them.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT=/mnt/c/tmp/deyin-overlay-e2e
WIN_OUT='C:\tmp\deyin-overlay-e2e'
ELECTRON="$OUT/node_modules/electron/dist/electron.exe"

if [ ! -f "$ELECTRON" ]; then
  VERSION="$(node -p "require('$ROOT/apps/desktop/node_modules/electron/package.json').version")"
  echo "no Windows Electron at $ELECTRON; install it once with:" >&2
  echo "  mkdir -p $OUT && cd $OUT && echo '{\"private\":true}' > package.json \\" >&2
  echo "    && npm_config_platform=win32 npm_config_arch=x64 npm i electron@$VERSION \\" >&2
  echo "    && (cd node_modules/electron && npm_config_platform=win32 npm_config_arch=x64 node install.js)" >&2
  exit 2
fi

cd "$ROOT"
ESBUILD="$(node -e "const p=require('path');const t=require.resolve('tsx/package.json',{paths:['$ROOT']});console.log(require.resolve('esbuild/bin/esbuild',{paths:[p.dirname(t)]}))")"
"$ESBUILD" scripts/e2e/overlay-entry.ts --bundle --platform=node --format=cjs --external:electron --outfile="$OUT/service.cjs" --log-level=warning
cp scripts/e2e/overlay-electron-e2e.cjs "$OUT/main.cjs"
cp scripts/e2e/overlay-win32.ps1 "$OUT/overlay-win32.ps1"
rm -f "$OUT/log.txt"

export SHOW_MS="${SHOW_MS:-0}" NO_PROTECT="${NO_PROTECT:-0}"
export WSLENV="SHOW_MS:NO_PROTECT${WSLENV:+:$WSLENV}"

WIN_ELECTRON="$WIN_OUT\\node_modules\\electron\\dist\\electron.exe"

# Windows processes started from an Electron app (Cursor, VS Code) inherit ELECTRON_RUN_AS_NODE=1, which turns
# electron.exe into plain Node with no `app`. Clear it for this process only, through cmd (no space before &&).
cd "$OUT"
set +e
timeout 170 cmd.exe /c "set ELECTRON_RUN_AS_NODE=&& $WIN_ELECTRON $WIN_OUT\\main.cjs" > "$OUT/stdout.txt" 2>&1
code=$?
set -e
cat "$OUT/log.txt" 2>/dev/null || echo "(no log written; electron exit $code)"
exit "$code"
