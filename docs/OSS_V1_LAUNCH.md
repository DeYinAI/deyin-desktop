# Open-source v1 launch checklist

Use this before tagging **`v1.0.0`** and announcing Deyin as public OSS.

## Repository & legal

- [x] Public repo `DeYinAI/deyin-desktop`
- [x] [LICENSE](../LICENSE) (PolyForm Noncommercial 1.0.0)
- [x] [TRADEMARK.md](../TRADEMARK.md)
- [x] [SECURITY.md](../SECURITY.md)
- [x] [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] Create `@DeYinAI/core` GitHub team (CODEOWNERS approvers)

## CI/CD (automated)

- [x] `verify` on dell-runner ([ci.yml](../.github/workflows/ci.yml))
- [x] CodeQL + dependency-review
- [x] Openference AI review (same-repo PRs; [docs/CI.md](./CI.md))
- [x] Dependabot (npm, actions, cargo)
- [x] Release builds Linux + Windows on **dell-runner only** ([release.yml](../.github/workflows/release.yml))
- [ ] Enable **Dependency graph** ([settings](https://github.com/DeYinAI/deyin-desktop/settings/security_analysis))
- [ ] Branch protection on `main`: require `verify`, `codeql`, Code Owners

## Runner setup (dell-runner host)

```bash
sudo bash scripts/ci/setup-dell-runner.sh   # Wine + .NET 8 + Bun
bash scripts/ci/check-dell-runner.sh
```

- [x] Wine installed (NSIS cross-build)
- [x] .NET 8 SDK (computer-use-host win-x64 publish)
- [ ] Remove deprecated **win-runner** from GitHub Actions runners

## Secrets

| Secret | Required for |
|--------|----------------|
| `OPENFERENCE_API_KEY` | AI PR review |
| `RELEASES_TOKEN` | Mirror + publish `DeYinAI/deyin-releases` |
| `WIN_CSC_*`, `CSC_*`, `APPLE_*` | Signed installers (optional v1) |

## External repos

- [ ] [`DeYinAI/deyin-releases`](https://github.com/DeYinAI/deyin-releases) — public, empty OK; CI publishes installers
- [ ] [`DeYinAI/registry`](https://github.com/DeYinAI/registry) — public plugin catalog for in-app marketplace

## Version & release

- [x] Desktop + root version **1.0.0**
- [ ] `bash scripts/verify.sh` green on `main`
- [ ] Tag `v1.0.0` → verify Release workflow succeeds
- [ ] Confirm `DeYinAI/deyin-releases` release is **published** (not draft) — required for auto-update
- [ ] Smoke-test installer on Windows + Linux

## Client updates (user-facing)

- [x] `electron-updater` → `DeYinAI/deyin-releases`
- [x] In-app `UpdateBanner` on new version
- [x] Settings → **Check for updates**
- [x] Periodic re-check every 24h
- [ ] Publish first `v1.0.0` release so updater has a target

## Docs accuracy

- [x] [PLUGINS_AND_MCP.md](./PLUGINS_AND_MCP.md) — GitHub plugins, not npm kernel packages
- [x] [CI.md](./CI.md) — PR/fork/Dependabot behavior
- [ ] [CHANGELOG.md](./CHANGELOG.md) — v1.0.0 section
- [ ] README points to correct update feed (GitHub releases)

## npm scope (explicit non-goals for v1)

- [ ] **Do not** claim `npm install -g @deyin/cli` until publish job exists
- [ ] Kernel `@deyin/*` packages stay monorepo-private

## Announce

- [ ] GitHub Release notes for v1.0.0
- [ ] Update homepage/docs.deyin.ai if needed
- [ ] Invite first external contributors (CONTRIBUTING + PR template ready)
