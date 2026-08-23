# Contributing

Thanks for your interest in Deyin. This project is open source under the
[PolyForm Noncommercial License](../LICENSE). Commercial use requires a separate
license — see [TRADEMARK.md](../TRADEMARK.md) for brand policy.

## Getting started

1. Fork the repository (or ask for collaborator access for full CI including AI review)
2. Install dependencies: `pnpm install --frozen-lockfile`
3. Run verification: `bash scripts/verify.sh`

## Pull requests

- Open a PR against `main` using the PR template
- All PRs must pass CI checks (see [docs/CI.md](docs/CI.md))
- Merges require approval from `@DeYinAI/core` (CODEOWNERS)

### What runs on your PR

| Check | Fork PR | Same-repo PR | Dependabot PR |
|-------|---------|--------------|---------------|
| verify | yes | yes | yes |
| CodeQL | yes | yes | yes |
| dependency-review | yes | yes | yes |
| AI review (Openference) | no | yes | no (comment only) |

Fork contributors: open a PR from your fork — static checks run automatically.
Maintainers can cherry-pick to an in-repo branch for full AI review.

## Code review

Internal PRs receive automated Bugbot + Security Review via Openference. Address
Critical/High findings before merge. Medium/Low findings are advisory.

## Questions

Contact **hello@deyin.ai** for licensing, trademark permissions, or maintainer access.
