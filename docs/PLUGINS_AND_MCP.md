# Plugins, MCP, and distribution (v1)

How extensibility works in Deyin v1 — and what is **not** on npm.

## Two plugin layers

| Layer | What | Install channel | npm? |
|-------|------|-----------------|------|
| **Kernel plugins** | In-process TypeScript (`@deyin/tools`, `@deyin/llm`, optimization, etc.) | Baked into desktop/web/CLI at build time | **No** — monorepo `private: true` |
| **Content plugins** | Skills, commands, subagents, hooks, MCP configs (`.deyin-plugin/plugin.json`) | **GitHub tarball** | **No** — not npm packages |

Third-party authors extend Deyin via **content plugins on GitHub**, not `@deyin/*` npm packages.

---

## Content plugins (Settings → Plugins)

**Install sources:**

- `owner/repo` — GitHub archive at default branch
- `owner/repo@v1.2.3` — pinned ref
- `https://github.com/owner/repo` — URL form
- Official catalog: [`DeYinAI/registry`](https://github.com/DeYinAI/registry) (`registry.json`)

**Install location:** `<userData>/plugins/` (desktop only).

**Bundled first-party plugins** (ship inside the app, copied to `bundled-*` on startup):

| Plugin | Path |
|--------|------|
| browser | `apps/desktop/bundled-plugins/browser/` |
| computer-use | `apps/desktop/bundled-plugins/computer-use/` |
| security | `apps/desktop/bundled-plugins/security/` |
| visualize | `apps/desktop/bundled-plugins/visualize/` |

**Authoring:** add `.deyin-plugin/plugin.json` plus `skills/`, `commands/`, `agents/`, `hooks/`, or `mcp.json`. See [FEATURES.md](./FEATURES.md).

---

## MCP servers (Settings → MCP)

**Catalog:** 26 curated entries in `apps/desktop/src/main/mcp-catalog/*.json`.

**Install flow:**

1. User picks a catalog server → manifest written to `~/.deyin/mcp-modules/<id>/`
2. **Remote HTTP/SSE** servers — URL + token/OAuth (Stripe, Sentry, etc.)
3. **stdio servers** — config uses `npx -y @modelcontextprotocol/server-*` at **runtime** (npm is invoked by the MCP process, not installed by Deyin)

MCP OAuth uses PKCE + encrypted token storage under `<userData>/mcp-oauth/`.

**Web:** MCP install/OAuth requires the desktop app today.

---

## CLI distribution

| Channel | Status | How |
|---------|--------|-----|
| **GitHub Release binaries** | **v1 primary** | `deyin-linux-x64`, `deyin-windows-x64.exe`, etc. from `release.yml` |
| **install.sh** | **v1 primary** | `curl …/cdn.deyin.ai/cli/install.sh` or repo `scripts/install.sh` |
| **`npm install -g @deyin/cli`** | **Not v1** | Package is `private: true`; no npm publish job yet |

---

## Desktop app updates

| Item | Value |
|------|--------|
| Update feed | Public repo [`DeYinAI/deyin-releases`](https://github.com/DeYinAI/deyin-releases) |
| Client check | ~10s after launch + every 24h + manual **Check now** in Settings |
| User notification | In-app `UpdateBanner` (Download → Restart) |
| Manifests | `latest.yml` (Windows), `latest-linux.yml` (Linux) generated at package time |

The CDN path `cdn.deyin.ai/desktop/releases` is optional mirroring — the baked-in updater uses the GitHub provider.

---

## What we do **not** publish to npm (v1)

All core packages remain monorepo-private:

- `@deyin/agent-core`, `@deyin/host-core`, `@deyin/tools`, `@deyin/llm`, kernel plugins, bundles, UI, CLI

**Future:** `@deyin/cli` and `@deyin/oauth-client` may get npm publishes post-v1; docs will be updated when that ships.

---

## External repos for OSS ecosystem

| Repo | Purpose |
|------|---------|
| `DeYinAI/deyin-desktop` | Source (this repo) |
| `DeYinAI/deyin-releases` | Public installers + update manifests |
| `DeYinAI/registry` | Plugin marketplace catalog |

Ensure `DeYinAI/registry` is public before launch so the in-app catalog works offline of private repos.

**Authoring:** see the [registry README](https://github.com/DeYinAI/registry/blob/main/README.md) for manifest layout, MCP patterns, secrets, and OAuth prerequisites.
