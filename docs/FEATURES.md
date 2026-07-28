# Deyin Feature Set

Deyin targets the capability surface of a modern agentic development environment. Each
feature below is implemented as original code in this repository. This document is the
functional specification the apps are built against; it contains no third-party code.

## Workspace & tasks
- Multiple projects, each with its own task list.
- A task is a durable conversation tied to a working directory, its file changes, and its
  run/unread/failed status.
- Command palette (Ctrl/Cmd+K): new task, open folder, search files, switch theme, open
  settings, toggle terminal, navigate chats.

## Agent chat
- Streaming chat with an Openference-hosted model.
- `@` to attach files/folders as context, `/` for slash commands, `$` to invoke skills,
  `#` to link related conversations.
- Two independent control axes (Cursor-style split):
  - **Composer modes** — Agent (build), Plan (read-only research that ends in a
    reviewable plan) and Ask (read-only Q&A). Cycled with `Shift+Tab`; the mode menu
    opens with `Ctrl/Cmd+.`. Plan and Ask stay read-only even under full access.
  - **Access levels** — "Full access", "Ask before changes", "Read only". Gates tool
    calls through the permission engine; "ask" actions surface an approval prompt with
    Allow once / Allow for session / Deny.
- Plan flow: a plan-mode run finishes with a plan card in the timeline and the plan
  document in the workspace panel's Plan tab; **Build** switches the task to Agent mode
  and executes the plan.
- Rich timeline: markdown output (GFM tables, task lists, themed code blocks),
  collapsible "Thought for Ns" reasoning cards, tool cards with expandable results,
  live todo checklists, and file-change cards with +/− counts that open the Diff tab.
- Goal mode: set a verifiable objective; the agent iterates until it reports the goal met.
- Change review: file edits are presented as a reviewable diff before they are applied.

## Host capabilities
- **Terminal**: full PTY via `node-pty`, streamed to the renderer.
- **File explorer**: list/read/write/watch within the workspace root.
- **Git**: status, diff, stage, commit, branch, log.
- **Exec**: run build/test/dev commands and stream output.
- **Embedded browser preview**: open a local URL, capture DOM elements as agent context.

## Skills
- A skill is a directory containing a `SKILL.md` (front-matter + instructions).
- Sources: built-in defaults shipped with Deyin, user global (`~/.deyin/skills`),
  project (`.deyin/skills`), and plugin-provided. Only `.deyin` directories are scanned.
- Skills are advertised to the model (name + description); it reads the SKILL.md on use.
- Invoke manually in chat with `/skill-name`; author new ones with `/create-skill`.
- A user or project skill with the same name overrides the built-in version.

## Commands
- One markdown file per command in `.deyin/commands/` (project) or `~/.deyin/commands/`.
- The filename is the command name; `$ARGUMENTS` receives the text after the command.
- The composer autocompletes `/` from commands plus invocable skills.

## Subagents
- Markdown definitions in `.deyin/agents/*.md` with front-matter (`name`, `description`,
  `model`, `readonly`, `is_background`); the body is the subagent's system prompt.
- The main agent delegates through the `task` tool; subagents run with a clean context.
- Built-ins: `explorer`, `reviewer`, `test-runner`.

## Hooks
- `hooks.json` (project `.deyin/hooks.json` or user `~/.deyin/hooks.json`), schema
  `{ "version": 1, "hooks": { "<event>": [{ "command", "timeout", "matcher", "failClosed" }] } }`.
- Events: `sessionStart`, `preToolUse`, `postToolUse`, `beforeShellExecution`,
  `afterShellExecution`, `stop`. Payload arrives as JSON on stdin; exit code 2 blocks the
  action; failures fail open unless `failClosed`.

## Plugins
- A plugin bundles skills, slash commands, subagents, MCP servers, and hooks.
- Manifest at `.deyin-plugin/plugin.json` (Cursor `.cursor-plugin/plugin.json` accepted);
  components are auto-discovered from `skills/`, `commands/`, `agents/`, `hooks/hooks.json`,
  `mcp.json`, or a root `SKILL.md` for single-skill plugins.
- Installed from GitHub (`owner/repo`, `owner/repo@ref`, URLs) into the user plugin library;
  the official catalog is the `DeYinAI/registry` repo. Secret `variables` are entered in
  settings and stored encrypted, substituted as `${VAR}` in plugin MCP configs.

## Automations
- Scheduled or event-triggered prompts (cron-like recurrence or file/git events).
- Each automation is a saved prompt + trigger + target project.

## MCP
- Connect Model Context Protocol servers; discover and call their tools from chat.
- Config: `.deyin/mcp.json` (project) and `~/.deyin/mcp.json` (user).
  Transports: stdio, SSE, Streamable HTTP.
- `${env:NAME}`, `${workspaceFolder}` and `${userHome}` interpolate in commands/URLs.
- Tools register as `mcp__<server>__<tool>` and go through the permission engine.

## Indexing
- Live local semantic index: chunked workspace files embedded on-device (hash n-gram
  backend by default; the optional `@huggingface/transformers` MiniLM backend is used
  when installed), stored under the app data directory, kept in sync by a watcher.
- `.gitignore` is respected; `.deyinignore` adds index-only exclusions.
- Exposed to the agent as the `codebase_search` tool.

## Identity & billing
- Sign in with Openference (OAuth 2.0 + PKCE). Profile menu shows name, email, avatar, plan.
- The same access token authorizes model calls; no separate API key entry required.
- **Identity & Access settings page**: live snapshot of the account and workstation —
  member profile, plan/role, workspace folder, device hostname, app version, tenant/org/
  policies (reported by the account API), and a stable workspace fingerprint
  (SHA-256 of machine id + workspace path, displayed truncated).
- Identity sync: the workstation registers itself with Openference (`POST /api/identity/sync`)
  on sign-in, on startup and on demand ("Sync identity now"); the last-synced timestamp
  persists locally.
- Vault status: provider keys and plugin secrets are counted and shown as stored
  locally, encrypted by the OS keychain; cloud vault sync is surfaced as "not
  configured" until the service exists (never faked).

## Diagnostics & telemetry
- The app writes a real rotating log at `<logs>/deyin.log` (main-process console,
  uncaught exceptions, and renderer errors forwarded over IPC). "Copy log path" in
  the task menu points at this file.
- **Send diagnostics** (Identity & Access page, or the task menu): uploads a scrubbed
  bundle — log tail, environment summary, redacted settings, workspace fingerprint —
  to `POST /api/diagnostics`; secrets (API keys, tokens, OAuth codes) are stripped
  before upload. The returned report id is the support reference.
- Usage telemetry is opt-in (off by default). When enabled, anonymous feature-usage
  events flush to `POST /api/telemetry` under a random install id, and anonymous
  usage counters are included in diagnostics bundles; when disabled neither leaves
  the device.

## Multi-model
- Model picker backed by Openference's live `/v1/models` catalog.
