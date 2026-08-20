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
- Plan flow: while the plan is written, the full markdown streams only into the workspace
  panel's Plan tab; chat shows a compact plan-file card (Open / Build). **Build** switches
  the task to Agent mode and executes the plan.
- Workspace panel (right): **Files** (tree + viewer/editor), **Plan**, **Diff** (latest
  agent edit), **Git** (status, stage, commit, branches), and **Browser**. The panel starts collapsed and opens automatically when
  there is content to show (plan, diff, browser, etc.).
- Rich timeline: markdown output (GFM tables, task lists, themed code blocks),
  collapsible "Thought for Ns" reasoning cards, tool cards with expandable results,
  live todo checklists, and file-change cards with +/− counts that open the Diff tab.
- Goal mode: set a verifiable objective; the agent iterates until it reports the goal met.
- Change review: file edits are presented as a reviewable diff before they are applied
  (Settings → Change review, or automatically in Ask before changes mode).

## LobeHub-inspired UX checklist (interaction polish)

These patterns borrow interaction ideas from [LobeHub](https://github.com/lobehub/lobehub)
without adopting its operator/lifestyle scope:

- **Attachment chips** — `@` file/folder picks render as removable chips above the composer;
  drag-drop and Add attachment use the same pipeline.
- **Linked thread chips** — `#` picks other tasks in the project; summaries inject on send.
- **Pending-change banner** — when review mode is on, a persistent Accept/Reject banner
  appears above the composer (and per-file actions in the Diff tab).
- **Goal card** — active thread goals show inline above the composer until met or cleared.
- **Goal modal** — set or clear goals via an inline dialog (no browser `prompt()`).
- **Context budget warning** — large `@` attachments show a warning before send.
- **Chat history chips** — past user messages show attachment and linked-thread chips.
- **Tray review badge** — system tray tooltip/menu reflects pending change-review count.

## Host capabilities
- **Terminal**: full PTY via `node-pty`, streamed to the renderer. User tabs are
  independent of the agent; agent sessions appear as attachable **Agent** tabs.
- **File explorer**: workspace file tree in the workspace panel's **Files** tab — browse
  folders (lazy-loaded), open text files with syntax highlighting, edit and save in place.
  Host RPC: `files.tree`, `files.read`, `files.write` (desktop and web).
- **Git**: status, diff, stage, commit, branch, log.
- **Exec**: agent `bash` runs in a **persistent per-thread PTY** (desktop). Output
  streams live into the chat tool card (`tool-delta`) and into the Agent terminal tab.
  Working directory and environment persist across calls in the same chat. Falls back
  to one-shot `spawn` when `node-pty` is unavailable (CLI, headless). Settings →
  Terminal controls whether the panel opens on the first agent command.
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
- Manifest at `.deyin-plugin/plugin.json` (Codex `.codex-plugin/plugin.json` and Cursor `.cursor-plugin/plugin.json` accepted);
  components are auto-discovered from `skills/`, `commands/`, `agents/`, `hooks/hooks.json`,
  `mcp.json`, `.mcp.json`, or a root `SKILL.md` for single-skill plugins.
- **Bundled first-party plugins** ship with the desktop app (browser, computer-use, chrome, visualize, security)
  and materialize to `<userData>/plugins/bundled-*` on startup. Marketplace cards show `interface` metadata
  (display name, category, default prompts, brand color).
- Installed from GitHub (`owner/repo`, `owner/repo@ref`, URLs) into the user plugin library;
  the official catalog is the `DeYinAI/registry` repo. Secret `variables` are entered in
  settings and stored encrypted, substituted as `${VAR}` in plugin MCP configs.

## Desktop automation (bundled plugins)
- **Browser** (`browser_*` tools): in-app workspace webview — localhost, snapshots with element refs, tabs, fill/hover/drag.
- **Computer use** (`computer_*` tools, Windows): Native C# host (`deyin-computer-use-host.exe`) over named pipe with UIA tree inspection, screenshots, and SendInput automation. Tools: `computer_launch_app`, `computer_list_windows`, `computer_click`, `computer_type`, `computer_set_value`. Default-deny app allowlist in Settings → Computer Use; Esc cancels in-flight actions; screenshot retention configurable. Linux and macOS hosts deferred.
- **Chrome** (`chrome_*` tools, Windows): consent dialog + persisted consent; attach-or-launch with Default profile; origin approval on first navigation; expanded tool parity (fill, hover, scroll, tabs, screenshot).
- **Visualize** (`visualize_write`): path-safe HTML fragments embedded in chat via `::deyin-inline-vis{}` with tightened CSP.
- **Security**: workspace-bounded MCP scans (semgrep when available, regex fallback, npm audit); findings panel in workspace Security tab; diff scan from Git tab; triage/threat-model skills.

## MCP OAuth (catalog servers)
- Remote MCP catalog entries that require OAuth use native browser consent with PKCE.
- A loopback HTTP listener captures the authorization callback; `state` is validated to prevent CSRF.
- Tokens and client registration are stored encrypted per module under `<userData>/mcp-oauth/`.
- Settings → MCP shows auth status (none / authenticated / expired) and supports revoke + re-auth.

## Automations
- Scheduled or manual agent runs with saved prompts, model selection, and workspace targets.
- **Local**: runs in the desktop app main process with full tool access (unattended).
- **Remote (SSH)**: connects to a Linux server and runs `deyin run --json -y` with the Openference account token via `DEYIN_TOKEN` (ephemeral per-run; never stored on the server). Custom providers are not supported for SSH targets.
- Triggers: cron schedules (hourly, daily, weekdays, custom) or manual **Run now**.
- SSH host credentials (private keys, passphrases, passwords) are encrypted at rest via OS keychain (`safeStorage`). Host keys are pinned on first connect.
- Configure SSH hosts under Settings → SSH hosts; manage automations from the sidebar **Automations** view (desktop only).
- Optional **Keep running in background** (General settings) keeps the scheduler alive in the system tray when windows are closed.
- Note: the token and prompt are streamed over the SSH channel's stdin, so they never appear in the remote command line (`/proc/<pid>/cmdline`) or in the login shell's environment. `DEYIN_TOKEN` is still present in the `deyin` child process environment while a run is active, so treat the SSH host as a trusted machine.

## MCP
- Connect Model Context Protocol servers; discover and call their tools from chat.
- Config: `.deyin/mcp.json` (workspace), legacy `~/.deyin/mcp.json` (migrated on upgrade),
  and per-server modules at `~/.deyin/mcp-modules/<id>/` (each with `module.json` + `mcp.json`).
- Transports: stdio, SSE, Streamable HTTP.
- `${env:NAME}`, `${workspaceFolder}` and `${userHome}` interpolate in commands/URLs/headers.
- Tools register as `mcp__<server>__<tool>` and go through the permission engine.
- **Catalog** — Settings → MCP lists 26 curated servers (Stripe, Cloudflare, Vercel,
  GitHub, Supabase, Linear, Sentry, etc.) with one-click install into isolated module dirs.
  OAuth servers use native browser consent (PKCE); tokens are stored encrypted on device.
  Token-only servers accept API keys during install.
- Catalog source of truth: `docs/mcp-catalog.json` and `apps/desktop/src/main/mcp-catalog/*.json`.

## Indexing
- Live local semantic index: chunked workspace files embedded on-device (hash n-gram
  backend by default; the optional `@huggingface/transformers` MiniLM backend is used
  when installed), stored under the app data directory, kept in sync by a watcher.
- `.gitignore` is respected; `.deyinignore` adds index-only exclusions.
- Exposed to the agent as the `codebase_search` tool.

## Identity & billing
- Sign in with Openference (OAuth 2.0 + PKCE). Profile menu shows name, email, avatar, plan.
- The same access token authorizes model calls; no separate API key entry required.
- **Plans & billing** (Settings → Plans or profile menu): browse the public catalog, switch tiers,
  toggle monthly/annual billing, and complete checkout via Stripe. Downgrades to a lower tier or
  Free are scheduled for the end of the current period; upgrades can apply immediately with proration.
  Cross-currency plan changes prompt for confirmation and use a dedicated 3DS completion flow when required.
  Checkout return URLs (`/pricing/success`, `/pricing/canceled`) are detected to refresh billing state.
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
- Catalog entries are classified: chat models stream completions, vision models accept
  image attachments, and text-to-image models are tagged **Image** in the picker.

## Image generation
- Text-to-image models (SDXL, FLUX, DALL·E and friends) are detected from the catalog's
  modality metadata, with a curated id heuristic as fallback (`host-core/src/images.ts`).
- Picking an image model in the composer sends the prompt straight to the provider's
  OpenAI-compatible `/images/generations` endpoint — no chat completion involved.
- The agent can generate pictures mid-task with the `generate_image` tool (prompt, model,
  size, `n`, negative prompt) and the built-in `/generate-image` skill covers prompt
  craft, sizes and iteration.
- Results are stored per thread (desktop: `userData/images/<thread>`, web: inside the
  session sandbox) and embedded in the reply as `::deyin-inline-image{file="…" alt="…"}`,
  which the chat renders as an inline picture, lazily decoded when it scrolls into view.
