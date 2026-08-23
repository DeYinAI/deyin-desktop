#!/usr/bin/env bash
# Full monorepo verification: build shared packages, then typecheck, test, and build apps.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Building shared packages (needed for app type resolution)"
pnpm --filter "./packages/**" build

echo "==> Building native-core (Rust; skipped gracefully if cargo is missing — TS fallbacks cover it)"
if command -v cargo >/dev/null 2>&1; then
  pnpm --filter @deyin/native-core build
else
  echo "    cargo not found; using TS fallbacks"
fi

echo "==> Building computer-use-host"
pnpm --filter @deyin/computer-use-host build

echo "==> Linting core packages and apps"
pnpm lint

echo "==> Typechecking all workspaces"
pnpm -r typecheck

echo "==> Running unit + integration tests"
pnpm -r test

echo "==> Building desktop app"
pnpm --filter @deyin/desktop build

echo "==> Building web app (client + server)"
pnpm --filter @deyin/web build

echo "==> Building CLI"
pnpm --filter @deyin/cli build

echo "==> All green."
