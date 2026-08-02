#!/usr/bin/env bash
# Full monorepo verification: build shared packages, then typecheck, test, and build apps.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Building shared packages (needed for app type resolution)"
pnpm --filter "./packages/**" build

echo "==> Building computer-use-host"
pnpm --filter @deyin/computer-use-host build

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
