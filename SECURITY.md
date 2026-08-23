# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| latest release on `main` | yes |
| older tags | best effort |

## Reporting a vulnerability

**Do not open public GitHub issues for security vulnerabilities.**

Email **hello@deyin.ai** with:

- Description of the issue and impact
- Steps to reproduce
- Affected versions or commits

We aim to acknowledge within 72 hours and provide a remediation timeline for confirmed issues.

## Automated scanning

This repository uses:

- **CodeQL** on pull requests and `main`
- **Dependabot** for dependency updates
- **dependency-review** on pull requests (requires [Dependency graph](https://github.com/DeYinAI/deyin-desktop/settings/security_analysis) enabled)
- **Openference AI review** (Bugbot + Security) on same-repo pull requests

External fork PRs receive static checks only; secrets are not exposed to untrusted code.
