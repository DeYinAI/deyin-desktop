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

## CI

- `.github/workflows/ci.yml` — runs `scripts/verify.sh` on every push/PR.
- `.github/workflows/release.yml` — on a `v*` tag: the `build` matrix regenerates icons,
  builds installers on macOS/Windows/Linux (`.dmg` / `.exe` / `.AppImage` + `.deb`) and
  uploads them as workflow artifacts; the `release` job then attaches all of them to a
  draft GitHub Release for the tag. Add signing secrets (and optionally CDN sync) to
  finish the pipeline. Note: `deyin-desktop` must be initialized as a git repo and pushed
  to GitHub for these workflows to run.

## Version bump

Update `apps/desktop/package.json` `version`, tag `vX.Y.Z`, and push the tag to trigger the
release workflow.
