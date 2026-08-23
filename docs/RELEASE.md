# Release

Packaging and distributing Deyin. **v1.0.0 is the first public release** — all prior
GitHub release assets were removed so `v1.0.0` starts a clean public history.

## Prerequisites

Generate app icons ( `apps/desktop/build/` is gitignored — regenerated in CI):

```bash
pnpm --filter @deyin/branding make-icons
```

## Local package

```bash
# Host platform only
pnpm --filter @deyin/desktop package

# Linux + Windows on a Linux machine with Wine (same as dell-runner)
bash scripts/ci/package-desktop.sh all

# Unpacked dir (smoke test, faster)
pnpm --filter @deyin/desktop package:dir
```

## Code signing (optional)

### Windows
- `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`

### macOS (sign + notarize)
- `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

## Update feed

`electron-builder.yml` publishes to the public repo **`DeYinAI/deyin-releases`**.
Clients use `electron-updater` with GitHub provider — releases must be **published**
(not draft) for updates to work.

| Platform | Manifest |
|----------|----------|
| Windows | `latest.yml` |
| Linux | `latest-linux.yml` |
| macOS | `latest-mac.yml` (when built) |

## CI/CD

See [CI.md](./CI.md) for pull request automation.

### Tag a release

1. Ensure `main` CI is green
2. Bump `apps/desktop/package.json` `version` (and root if desired)
3. Commit, tag, push:

```bash
git tag v1.0.0
git push origin v1.0.0
```

### What the workflow does

[`.github/workflows/release.yml`](../.github/workflows/release.yml) on `v*` tags:

1. **create-release** — draft release on this repo + draft on `DeYinAI/deyin-releases`
2. **build** — dell-runner packages Linux + Windows installers
3. **cli** — cross-compiled CLI binaries
4. **publish** — `deyin-releases` release set to **published** (required for auto-update)

**Runner setup:**

```bash
sudo bash scripts/ci/setup-dell-runner.sh
bash scripts/ci/check-dell-runner.sh
```

**Secrets:** `RELEASES_TOKEN` (required for public feed), `WIN_CSC_*`, `CSC_*`, `APPLE_*` (optional signing).

## Version bump checklist

- [ ] `bash scripts/verify.sh` passes
- [ ] Update [CHANGELOG.md](./CHANGELOG.md)
- [ ] Tag `vX.Y.Z` and push
- [ ] Verify installers on [deyin-releases](https://github.com/DeYinAI/deyin-releases)
- [ ] Smoke-test one installer per platform
