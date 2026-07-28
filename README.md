# Deyin

An original, web-hostable **agentic development environment** with **Openference** sign-in.

Deyin is built from scratch. The renderer is a plain web SPA that runs both inside an
Electron desktop shell and behind a web server. Privileged work (terminal, files, git,
process exec) happens in a host process the renderer talks to over a typed RPC channel.
Identity and model access use Openference via OAuth 2.0 + PKCE.

> This repository contains only original code and permissively licensed open-source
> dependencies. It is not a fork or repackaging of any proprietary application.

## Monorepo layout

```
packages/
  oauth-provider/   Standalone OAuth 2.0 / OIDC server for Openference
  oauth-client/     Reusable PKCE client (desktop loopback, CLI device flow, web redirect)
  host-core/        Runtime-agnostic core: shared types/config, settings/providers/usage
                    stores, model + search clients, and host services (PTY, files, env)
  agent-core/       Agentic runtime: streaming tool-call loop, built-in tools (bash, read,
                    write, edit, grep, glob, ls, websearch, todo), permission engine,
                    sessions, layered config, MCP client
  branding/         Deyin logos, icons, theme tokens
apps/
  desktop/          Electron shell (main = host, renderer = UI)
  web/              Static renderer + per-session WebSocket host-server
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

## License

MIT. See [LICENSE](LICENSE).
