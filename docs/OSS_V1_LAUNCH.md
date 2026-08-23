# Open-source v1 launch checklist

**v1.0.0 is the first public release.** Pre-v1 GitHub releases were deleted from
`DeYinAI/deyin-desktop` and `DeYinAI/deyin-releases`.

## Repository & legal

- [x] Public repo `DeYinAI/deyin-desktop`
- [x] [LICENSE](../LICENSE) (PolyForm Noncommercial 1.0.0)
- [x] [TRADEMARK.md](../TRADEMARK.md)
- [x] [SECURITY.md](../SECURITY.md)
- [x] [CONTRIBUTING.md](../CONTRIBUTING.md)
- [x] Docs index [docs/README.md](./README.md)
- [ ] Create `@DeYinAI/core` GitHub team (CODEOWNERS approvers)

## CI/CD

- [x] `verify`, CodeQL, Dependabot, AI PR review
- [x] Release builds on dell-runner (Linux + Windows)
- [x] Pre-v1 GitHub releases cleaned
- [ ] Enable **Dependency graph** ([settings](https://github.com/DeYinAI/deyin-desktop/settings/security_analysis))
- [ ] Branch protection on `main`

## Runner (dell-runner)

```bash
sudo bash scripts/ci/setup-dell-runner.sh
bash scripts/ci/check-dell-runner.sh
```

- [ ] Remove deprecated **win-runner**
- [x] Wine + .NET 8 for cross-platform packaging

## External repos

- [x] `DeYinAI/deyin-releases` — empty, ready for v1.0.0
- [ ] `DeYinAI/registry` — public plugin catalog

## Ship v1.0.0

- [x] Version set to **1.0.0**
- [ ] CI green on `main`
- [ ] `git tag v1.0.0 && git push origin v1.0.0`
- [ ] Confirm [deyin-releases](https://github.com/DeYinAI/deyin-releases) has **published** v1.0.0 with installers
- [ ] Smoke-test Windows + Linux installers
- [ ] Write GitHub Release notes (first public release)

## Post-launch

- [ ] Branch protection + `@DeYinAI/core` reviews enforced
- [ ] Announce / update docs.deyin.ai
