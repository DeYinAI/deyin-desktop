# Deyin CLI

`deyin` is the terminal counterpart to the Deyin desktop app: an agentic coding assistant
with the same Openference account, model catalog, agents and built-in web search. It runs
as an interactive TUI or fully headless for scripts and CI.

## Install

```bash
# Single binary (macOS / Linux)
curl -fsSL https://cdn.deyin.ai/cli/install.sh | bash

# npm (all platforms, requires Node >= 20)
npm install -g @deyin/cli

# From source
pnpm install && pnpm --filter "./packages/**" build && pnpm --filter @deyin/cli dev
```

Binaries are published on GitHub Releases as `deyin-<os>-<arch>` and are self-updating
via `deyin upgrade`. npm installs update with `npm install -g @deyin/cli@latest`.

## Sign in

```bash
deyin login            # device flow: open the printed URL, enter the code
deyin login --browser  # RFC 8252 loopback flow (opens your browser)
deyin whoami
deyin logout
```

Tokens are stored in `~/.deyin/credentials.json` with 0600 permissions and refresh
automatically. The same Openference OAuth client id and scopes as the desktop app are
used, so one account covers both.

## Interactive TUI

```bash
deyin                  # new session in the current directory
deyin -c               # continue the latest session for this workspace
deyin resume           # pick a session from a list
deyin -m GLM-5.2 -a plan
```

While chatting:

| Key / command | Effect |
| --- | --- |
| `/help` | List commands |
| `/model`, `/agent` | Pickers for model and agent |
| `/new` | Fresh session |
| `/sessions` | Resume another session |
| `/compact` | Model-written summary replaces old context |
| `/usage` | Local usage statistics |
| `/login` | Device-flow sign-in without leaving the TUI |
| `Esc` | Cancel the current run (or clear the input) |
| `Ctrl+C` twice | Quit |

Tool calls stream in as cards. Tools that modify the machine (write, edit, bash, MCP
tools) prompt first: allow once, always allow for this session, or deny.

## Headless mode (scripts / CI)

```bash
deyin run "fix the failing test in src/utils.test.ts" --yes
git diff | deyin -p "review this diff for bugs"
deyin run "summarize this repo" --json | jq -r 'select(.type=="result").finalText'
```

- `-p` / positional / piped stdin provide the prompt (they concatenate).
- Assistant text streams to stdout; tool activity goes to stderr.
- `--json` emits NDJSON events (`text-delta`, `tool-start`, `tool-end`, `usage`, ...,
  final `result` record with `reason`, `steps`, `usage`, `sessionId`, `finalText`).
- Permission prompts are **auto-denied** headlessly; pass `--yes` to allow everything.
- `-c` / `--resume <id>` continue existing sessions.
- Exit codes: `0` completed, `1` error or step-cap, `2` not signed in, `130` interrupted.

## Agents

- `build` (default): full access, implements changes end to end.
- `plan`: read-only analysis; write/edit denied, bash asks.
- Custom agents come from config (below); list everything with `deyin agents`.

## Configuration

Layered, later wins: defaults -> `~/.deyin/config.json` -> project `deyin.json` (or
`.deyin/config.json`, walking up from cwd) -> `DEYIN_*` env vars -> flags.

```jsonc
// deyin.json
{
  "model": "GLM-5.2",
  "agent": "build",
  "thinking": true,
  "maxSteps": 40,
  "permissions": [
    { "tool": "bash", "action": "allow" },   // allow | ask | deny; tool name or "*"
    { "tool": "write", "action": "ask" }
  ],
  "agents": {
    "reviewer": {
      "description": "Reviews diffs without editing",
      "prompt": "You review code. Never modify files; report findings.",
      "permissions": [{ "tool": "*", "action": "deny" }, { "tool": "read", "action": "allow" }]
    }
  },
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

Env vars: `DEYIN_MODEL`, `DEYIN_AGENT`, `DEYIN_API_BASE_URL`, `DEYIN_OAUTH_ISSUER`,
`DEYIN_CLIENT_ID`, `DEYIN_THINKING`, `DEYIN_MAX_STEPS`, `DEYIN_DATA_DIR`.

### Project instructions

`AGENTS.md` (in the workspace or up to 5 parent directories) and every `*.md` under
`.deyin/rules/` are appended to the system prompt.

### Permissions model

Rules merge in three tiers, last writer wins: built-in tool defaults (read-only tools
allowed; write/execute ask) -> agent rules -> config rules. "Always allow" answers grant
the tool for the rest of the session. `--yes` skips everything (headless/CI).

### MCP servers

Configured stdio servers are launched on startup; their tools appear to the model as
`mcp__<server>__<tool>` and go through the same permission prompts (execute tier).
Servers that fail to start are skipped with a warning.

## Sessions

Transcripts persist as JSONL under `~/.deyin/sessions/`. `deyin sessions` lists them,
`deyin resume <id>` reopens one, `deyin -c` continues the newest for the cwd. `/compact`
rolls a long conversation into a model-written summary in a new session.

## Built-in tools

`bash` (one-shot shell via spawn — the desktop app uses a persistent PTY instead;
timeout + output caps), `read`, `write`, `edit` (exact-match string replace),
`grep` (ripgrep with JS fallback), `glob`, `ls`, `websearch` (DuckDuckGo, no API
key), `todo_write` (task tracking shown in the TUI).

## Updating

```bash
deyin upgrade   # binary installs self-update from GitHub Releases
```

The TUI shows a notice (checked at most once a day) when a newer release exists.

## Building release binaries

```bash
cd apps/cli
bun scripts/compile.mjs bun-linux-x64 dist-bin/deyin-linux-x64
```

CI cross-compiles macOS (x64/arm64), Linux (x64/arm64) and Windows (x64) from one runner
and attaches them to the GitHub Release; `release.yml` also publishes `@deyin/cli` (and
the workspace packages it depends on) to npm.
