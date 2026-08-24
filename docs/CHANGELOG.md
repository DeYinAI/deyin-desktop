# Changelog

All notable **public** releases are documented here.

**v1.0.0 is the first public open-source release.** Earlier versions (0.x–2.1.x)
were private beta builds; their release assets have been removed from GitHub.
See [archive/](./archive/) for pre-v1 internal notes.

## 1.0.1 — 2026-08-24

### Highlights

- Remote SSH workspaces with project picker (clone, browse, recent workspaces)
- Model reasoning options and chat UI improvements
- Computer-use host reliability fixes

## 1.0.0 — 2026-08-23

First public open-source release under the PolyForm Noncommercial License 1.0.0.

### Highlights

- Agentic IDE: desktop (Electron), web, and CLI with Openference OAuth
- Plugin system (GitHub install + bundled browser, computer-use, security, visualize)
- MCP catalog with OAuth support
- CI/CD: verify, CodeQL, Dependabot, Openference AI PR review
- Release builds: Linux + Windows installers from dell-runner; CLI binaries for all platforms
- In-app updates via public [DeYinAI/deyin-releases](https://github.com/DeYinAI/deyin-releases)

### Distribution

- Desktop: GitHub Releases + auto-update feed
- CLI: GitHub Release binaries + `scripts/install.sh`
- Content plugins: GitHub + [DeYinAI/registry](https://github.com/DeYinAI/registry)
- Kernel packages: monorepo source only (not on npm)

See [PLUGINS_AND_MCP.md](./PLUGINS_AND_MCP.md) and [RELEASE.md](./RELEASE.md) for details.
