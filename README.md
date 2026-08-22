# Deyin

An original, web-hostable **agentic development environment** with **Openference** sign-in.

Deyin is built from scratch. The renderer is a plain web SPA that runs both inside an
Electron desktop shell and behind a web server. Privileged work (terminal, files, git,
process exec) happens in a host process the renderer talks to over a typed RPC channel.
Identity and model access use Openference via OAuth 2.0 + PKCE.

## Monorepo layout

```
packages/
  kernel/           Plugin kernel (dsh-style): extension-api contracts + runtime
  tools/            The tools seam (@deyin/tools) + tool-family plugins
                    (fs, shell, git, web, plan, agent)
  llm/              The llm seam (@deyin/llm) + wire-adapter plugins
                    (openai, responses, anthropic)
  caps/             Capability-scan loader plugin (skills/commands/subagents/hooks/mcp)
  bundle/           Config layers: bundle-base + desktop-app/web-app/headless profiles
  ui/
    contract/       Typed RPC contract (IPC channel map, domain types, web WS protocol)
    client/         The one renderer SPA (@deyin/ui), consumed by desktop and web
  openference/      oauth-client: reusable PKCE client (desktop loopback, CLI device
                    flow, web redirect)
  oauth-provider/   Standalone OAuth 2.0 / OIDC server for Openference
  host-core/        Runtime-agnostic core: shared types/config, stores, host services
                    (PTY, files, env), session event journal
  agent-core/       Agentic runtime: streaming tool-call loop, tool implementations,
                    permission engine, sessions, layered config, MCP client
  plugins/          optimization: semantic caches (first kernel plugin, lazy)
  branding/         Deyin logos, icons, theme tokens
native/
  computer-use-host/  Windows sidecar binary (UIA/capture/input), zero importers
apps/
  desktop/          Electron shell (main = host; renderer = @deyin/ui)
  web/              Static renderer (@deyin/ui) + per-session WebSocket host-server
  cli/              `deyin` in the terminal: interactive TUI + headless mode
docs/               Architecture, features, capability manifest, OAuth guide, CLI guide
```

## Prerequisites

- Node.js >= 20
- pnpm 10.x

## Quick start

```bash
pnpm install

# Run the Openference OAuth provider locally (in-memory store, dev keys)
pnpm oauth:dev

# Run the desktop app in dev
pnpm desktop:dev

# Run the web app in dev
pnpm web:dev

# Run the CLI in dev (TUI)
pnpm --filter @deyin/cli dev
```

## CLI

The same account, models, agents and search — in your terminal. Interactive TUI plus a
headless mode for scripts and CI. See [docs/CLI.md](docs/CLI.md).

## Openference OAuth

Deyin authenticates against Openference. Because Openference currently ships only Bearer
API-key auth, this repo also provides `@deyin/oauth-provider` — a standard OAuth 2.0 /
OIDC server that issues tokens usable as Bearer credentials against
`https://api.openference.com/v1`. Any CLI can reuse the same flow via `@deyin/oauth-client`.

See [docs/OAUTH.md](docs/OAUTH.md).

## Public endpoints (`deyin.ai`)

Deyin-operated domains used by the apps (no secrets in the repo):

| URL | Purpose |
| --- | --- |
| `https://deyin.ai` | Product homepage |
| `https://docs.deyin.ai` | User documentation |
| `https://cdn.deyin.ai/cli/install.sh` | CLI one-line installer |
| `https://cdn.deyin.ai/desktop/releases` | Desktop auto-update feed (installers + manifests) |
| `https://cdn.deyin.ai/desktop/config/default.json` | Remote feature flags / defaults |

Contact: `hello@deyin.ai`. The local OAuth dev server uses a fictional demo user
`demo@deyin.ai` only for testing.

## License

Source is available under the **PolyForm Noncommercial License 1.0.0** — you may use,
modify, and share it for noncommercial purposes. **Commercial use, resale, and paid
hosting of this codebase require a separate license from Deyin** (`hello@deyin.ai`).

See [LICENSE](LICENSE).
