# CI/CD and pull request automation

This document describes what runs automatically on pull requests and releases for
`deyin-desktop`.

## Pull request checks

| Check | Workflow | Runner | When it runs |
|-------|----------|--------|--------------|
| **verify** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | Self-hosted Linux | All PRs and pushes to `main` |
| **dependency-review** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | GitHub-hosted | All PRs |
| **codeql** | [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml) | GitHub-hosted | All PRs, pushes to `main`, weekly |
| **ai-review** | [`.github/workflows/pr-ai-review.yml`](../.github/workflows/pr-ai-review.yml) | Self-hosted Linux | Same-repo PRs only |

### verify

Runs [`scripts/verify.sh`](../scripts/verify.sh):

1. Build shared packages
2. Build native-core (Rust, skipped if `cargo` is missing)
3. Build computer-use-host
4. Typecheck all workspaces
5. Run unit and integration tests
6. Build desktop, web, and CLI apps

### dependency-review

GitHub's dependency review action blocks PRs that introduce dependencies with
known vulnerabilities above the configured severity threshold.

### codeql

Static analysis for JavaScript/TypeScript. Results appear in the repository
**Security** tab.

### ai-review (Openference)

Automated code review using the same Bugbot and Security Review prompts as the
in-app subagents. The workflow:

1. Computes the PR diff against the base branch
2. Calls `https://api.openference.com/v1/chat/completions` twice (bugbot +
   security) with structured JSON output
3. Posts or updates a PR comment with findings
4. **Fails** the check if any Critical or High severity finding is reported

**Same-repo PRs only.** Fork PRs do not receive the Openference API key (secret
abuse prevention). External contributors still get `verify`, CodeQL, and
dependency-review.

**Required secret:** `OPENFERENCE_API_KEY` (`sk-of-...`) in repository settings.

## Merge requirements

Configure branch protection on `main` (GitHub Settings → Branches):

- Require pull request before merging
- Require 1 approval from **Code Owners** ([`.github/CODEOWNERS`](../.github/CODEOWNERS) → `@DeYinAI/core`)
- Require status checks: `verify`, `codeql`, `ai-review` (internal PRs)
- Require branches to be up to date
- Restrict direct pushes to `main`

Create the `@DeYinAI/core` team in the org and add only maintainers who should
approve merges.

## Dependabot

[`.github/dependabot.yml`](../.github/dependabot.yml) opens weekly PRs for npm
and GitHub Actions updates. Dependabot PRs go through the same CI and review
gates.

## Release (CD)

Tag `v*` on `main` to trigger [`.github/workflows/release.yml`](../.github/workflows/release.yml):

1. **create-release** — draft GitHub Release on this repo + mirror draft on
   `DeYinAI/deyin-releases` (needs `RELEASES_TOKEN`)
2. **build** — Electron installers (Windows, Linux) on self-hosted runners;
   assets attach directly to the draft release (no Actions artifacts)
3. **cli** — cross-compiled CLI binaries attached to the same release

Manual smoke build without a tag: **Actions → Release → Run workflow**
(`workflow_dispatch`).

See [RELEASE.md](./RELEASE.md) for signing secrets and version bump process.

## Local development

Before opening a PR:

```bash
pnpm install --frozen-lockfile
bash scripts/verify.sh
pnpm lint   # if ESLint is configured
```

## Fork contributors

External fork PRs receive static checks (`verify`, CodeQL, dependency-review)
but not AI review. A maintainer may cherry-pick or open a branch in-repo to
trigger the full pipeline including AI review.
