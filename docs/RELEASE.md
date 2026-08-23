# Release

Packaging and distributing the Deyin desktop app. All build tooling is standard
electron-builder; all bundled assets are built from this repository or declared dependencies.

## Prerequisites

Generate the app icons from the brand mark (`apps/desktop/build/` is gitignored, so
this runs before every package — locally and in CI):

```bash
pnpm --filter @deyin/branding make-icons
# -> apps/desktop/build/icon.png (512px) and icon.ico (multi-size)
```

`icon.png` doubles as the macOS source (electron-builder converts it to `.icns`), so no
separate `.icns` is needed. `sharp` + `png-to-ico` are already root devDependencies.

## Local package

```bash
pnpm --filter @deyin/desktop package        # installers in apps/desktop/release/
pnpm --filter @deyin/desktop package:dir     # unpacked dir (faster, for smoke tests)
```

## Code signing

### Windows
Set env vars (or CI secrets) before `package`:
- `WIN_CSC_LINK` — base64 or path to the `.pfx` certificate
- `WIN_CSC_KEY_PASSWORD` — its password

### macOS (sign + notarize)
- `CSC_LINK`, `CSC_KEY_PASSWORD` — Developer ID Application cert
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — for notarization

electron-builder notarizes automatically when the Apple env vars are present.

## Publishing to the update feed

`electron-builder.yml` uses a generic publish provider at
`https://cdn.deyin.ai/desktop/releases`. After `package`, upload everything in
`apps/desktop/release/` (installers + `latest*.yml` manifests) to that path. The app's
`electron-updater` integration (`main/updater.ts`) picks up new versions on launch.

## CI and CD

See [CI.md](./CI.md) for pull request automation (verify, CodeQL, AI review).

### Continuous integration

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — runs `scripts/verify.sh`
  on every push to `main` and on all pull requests (self-hosted Linux runner).
- [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml) — static analysis
  on GitHub-hosted runners.
- [`.github/workflows/pr-ai-review.yml`](../.github/workflows/pr-ai-review.yml) —
  Openference Bugbot + Security Review on same-repo PRs.

### Release (continuous delivery)

[`.github/workflows/release.yml`](../.github/workflows/release.yml) triggers on `v*` tags
(or manual `workflow_dispatch` for smoke builds):

1. **create-release** — creates a draft GitHub Release on this repo and mirrors a draft
   to `DeYinAI/deyin-releases` (requires `RELEASES_TOKEN`; non-fatal if missing).
2. **build** — **dell-runner (Linux only)** builds Linux (`.AppImage`, `.deb`) **and**
   Windows (`.exe` NSIS) installers via Wine + .NET cross-publish. No Windows
   self-hosted runner required. Assets attach directly to the draft release.
3. **cli** — cross-compiles CLI binaries with Bun on Linux and attaches them to the
   same release.

**Runner setup:** `sudo bash scripts/ci/setup-dell-runner.sh` then
`bash scripts/ci/check-dell-runner.sh`.

**Local cross-package smoke test:**

```bash
bash scripts/ci/package-desktop.sh all   # linux + win on Linux with Wine
```

macOS (`.dmg`) builds are disabled until a macOS self-hosted runner or hosted budget
is available.

Signing secrets for release jobs: `CSC_*`, `APPLE_*`, `WIN_CSC_*`, `RELEASES_TOKEN`.

## Version bump

Update `apps/desktop/package.json` `version`, tag `vX.Y.Z`, and push the tag to trigger the
release workflow. Ensure `main` has passed CI before tagging.
