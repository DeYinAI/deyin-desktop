# CI/CD and pull request automation

This document describes what runs automatically on pull requests and releases for
`deyin-desktop`.

## Pull request checks

| Check | Workflow | Runner | When it runs |
|-------|----------|--------|--------------|
| **verify** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | Self-hosted Linux (dell-runner) | All PRs and pushes to `main` |
| **dependency-review** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | GitHub-hosted | All PRs (needs Dependency graph enabled) |
| **codeql** | [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml) | GitHub-hosted | All PRs, pushes to `main`, weekly |
| **ai-review** | [`.github/workflows/pr-ai-review.yml`](../.github/workflows/pr-ai-review.yml) | Self-hosted Linux | Same-repo PRs (not Dependabot/forks) |

### verify

Runs [`scripts/verify.sh`](../scripts/verify.sh):

1. Build shared packages (native-core excluded from bulk build)
2. Build native-core if `cargo` is present (skipped gracefully otherwise)
3. Build computer-use-host TypeScript wrapper
4. Lint core packages and apps
5. Typecheck all workspaces
6. Run unit and integration tests
7. Build desktop, web, and CLI apps

### dependency-review

GitHub's dependency review action flags PRs that introduce dependencies with
known vulnerabilities at **high** severity or above.

**Enable once:** [Settings → Security → Dependency graph](https://github.com/DeYinAI/deyin-desktop/settings/security_analysis).

Until enabled, this job may fail harmlessly (`continue-on-error: true`).

### codeql

Static analysis for JavaScript/TypeScript. Results appear in the repository
**Security** tab.

### ai-review (Openference)

Automated code review using the same Bugbot and Security Review prompts as the
in-app subagents. The workflow:

1. Computes the PR diff against the base branch
2. Calls `https://api.openference.com/v1/chat/completions` twice (bugbot +
   security) with structured JSON output
3. Posts or updates a PR comment tagged `<!-- deyin-ai-review -->`
4. **Fails** the check if any Critical or High severity finding is reported

**Same-repo PRs only.** Fork PRs do not receive the Openference API key (secret
abuse prevention). External contributors still get `verify`, CodeQL, and
dependency-review.

**Dependabot PRs** skip AI review (GitHub withholds secrets from Dependabot
workflows) and receive an explanatory PR comment instead.

**Manual re-run:** Actions → PR AI Review → Run workflow → enter PR number.

**Required secret:** `OPENFERENCE_API_KEY` (`sk-of-...`) in repository settings.

**Optional variable:** `OPENFERENCE_REVIEW_MODEL` (repository variable). Defaults to
`GLM-5.2` when unset. Must be a model id from
[openference.com/models](https://openference.com/models) — OpenAI model names like
`gpt-4o-mini` are not valid on this gateway.

## Merge requirements (before public launch)

Configure branch protection on `main` (GitHub Settings → Branches):

- Require pull request before merging
- Require 1 approval from **Code Owners** ([`.github/CODEOWNERS`](../.github/CODEOWNERS) → `@DeYinAI/core`)
- Require status checks: `verify`, `codeql`, `ai-review` (internal PRs)
- Require branches to be up to date
- Restrict direct pushes to matching branches

Create the `@DeYinAI/core` team in the org and add only maintainers who should
approve merges.

## Dependabot

[`.github/dependabot.yml`](../.github/dependabot.yml) opens weekly PRs for npm,
GitHub Actions, and cargo. Dependabot PRs require maintainer review (`verify` +
CodeQL must pass; AI review is skipped).

## Release (CD)

Tag `v*` on `main` to trigger [`.github/workflows/release.yml`](../.github/workflows/release.yml):

1. **create-release** — draft GitHub Release on this repo + mirror draft on
   `DeYinAI/deyin-releases` (needs `RELEASES_TOKEN`)
2. **build** — Linux **and** Windows Electron installers from **dell-runner only**
   (Wine + .NET cross-publish; no Windows self-hosted runner required)
3. **cli** — cross-compiled CLI binaries attached to the same release

Manual smoke build without a tag: **Actions → Release → Run workflow**
(`workflow_dispatch`).

### Dell runner setup (one-time)

On the self-hosted Linux runner host:

```bash
sudo bash scripts/ci/setup-dell-runner.sh   # Wine, .NET 8 SDK, Bun
bash scripts/ci/check-dell-runner.sh        # verify
```

See [RELEASE.md](./RELEASE.md) for signing secrets and version bump process.

See [RUNNERS.md](./RUNNERS.md) for adding more self-hosted Linux runners.

## Local development

Before opening a PR:

```bash
pnpm install --frozen-lockfile
bash scripts/verify.sh
```

## Fork contributors

External fork PRs receive static checks (`verify`, CodeQL, dependency-review)
but not AI review. A maintainer may cherry-pick or open a branch in-repo to
trigger the full pipeline including AI review.
