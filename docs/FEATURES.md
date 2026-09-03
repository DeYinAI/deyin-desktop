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
- Markdown definitions in `.deyin/agents/*.md` (project) or `~/.deyin/agents/*.md` (user) with
  front-matter (`name`, `description`, `model`, `effort`, `max_steps`, `tools`, `readonly`,
  `is_background`); the body is the subagent's system prompt. Project beats user on a name clash.
- The main agent delegates through the `task` tool; subagents run with a clean context and
  return only their report. Delegation is model-driven: the `description` is what the model
  routes on, so write it as "when to use this".
- Built-ins: `explorer`, `reviewer`, `bugbot`, `security-review`, `test-runner`, `shell`,
  `browser`, `docs-researcher`, `ci-investigator`.
- Per-call overrides on the `task` tool: `readonly` (tightens a subagent for one call — it can
  never loosen a definition that is already read-only), `model` (`providerId::modelId` or a bare
  id; a model pinned in Settings still wins), and `background`.
- **Resume and fork**: a run returns an `agent_id`, and a later call may `resume` that transcript
  (same id, the subagent carries on with everything it learned) or `fork` it (new id, the source
  is left untouched — useful for exploring two directions from one investigation). Transcripts
  are stored per host and refused across sessions and across subagent names. The parent thread
  still only ever sees reports.

## Hooks
- `hooks.json` (project `.deyin/hooks.json` or user `~/.deyin/hooks.json`), schema
  `{ "version": 1, "hooks": { "<event>": [{ "command", "timeout", "matcher", "failClosed" }] } }`.
- Events: `sessionStart`, `preToolUse`, `postToolUse`, `beforeShellExecution`,
  `afterShellExecution`, `subagentStart`, `subagentStop`, `stop`. Payload arrives as JSON on
  stdin; exit code 2 blocks the action; failures fail open unless `failClosed`.
- `subagentStart` and `subagentStop` match on the **subagent name**. A `subagentStart` hook may
  refuse delegated work outright (exit 2 or `{"permission":"deny"}`) — the one place a policy can
  see into a `task` call. `subagentStop` cannot block (the work is done); what it prints as
  `additional_context` is appended to the report the parent receives.

## Plugins
- A plugin bundles skills, slash commands, subagents, MCP servers, and hooks.
- Manifest at `.deyin-plugin/plugin.json` (Codex `.codex-plugin/plugin.json` and Cursor `.cursor-plugin/plugin.json` accepted);
  components are auto-discovered from `skills/`, `commands/`, `agents/`, `hooks/hooks.json`,
  `mcp.json`, `.mcp.json`, or a root `SKILL.md` for single-skill plugins.
- **Bundled first-party plugins** ship with the desktop app (browser, computer-use, visualize, security)
  and materialize to `<userData>/plugins/bundled-*` on startup. Marketplace cards show `interface` metadata
  (display name, category, default prompts, brand color).
- Installed from GitHub (`owner/repo`, `owner/repo@ref`, URLs) into the user plugin library;
  the official catalog is the `DeYinAI/registry` repo. Secret `variables` are entered in
  settings and stored encrypted, substituted as `${VAR}` in plugin MCP configs.

## Desktop automation (bundled plugins)
- **Browser** (`browser_*` tools): in-app workspace webview — localhost, snapshots with element refs, tabs, fill/hover/drag.
- **Computer use** (`computer_*` tools, Windows): Native C# host (`deyin-computer-use-host.exe`) over named pipe with UIA tree inspection, screenshots, and SendInput automation. Tools: `computer_launch_app`, `computer_list_windows`, `computer_click`, `computer_type`, `computer_set_value`. Default-deny app allowlist in Settings → Computer Use; Esc cancels in-flight actions; screenshot retention configurable. Linux and macOS hosts deferred.
- **Chrome** (`chrome_*` tools, Windows): planned; use the **browser** bundled plugin for in-app web automation today.
- **Visualize** (`visualize_write`): path-safe HTML fragments embedded in chat via `::deyin-inline-vis{}` with tightened CSP.
- **Security**: workspace-bounded MCP scans (semgrep when available, regex fallback, npm audit); findings panel in workspace Security tab; diff scan from Git tab; triage/threat-model skills.

## MCP OAuth (catalog servers)
- Remote MCP catalog entries that require OAuth use native browser consent with PKCE.
- A loopback HTTP listener captures the authorization callback; `state` is validated to prevent CSRF.
- Tokens and client registration are stored encrypted per module under `<userData>/mcp-oauth/`.
- Settings → MCP shows auth status (none / authenticated / expired) and supports revoke + re-auth.

## Automations
- Scheduled or manual agent runs with model selection and workspace targets.
- Each automation runs one of three payloads: a **prompt** you write, a **skill**, or a **subagent**. Skills and subagents are resolved by name on every run, so editing the `SKILL.md` changes what the automation does without touching the automation.
- **Local**: runs in the desktop app main process with full tool access (unattended). A subagent payload delegates in-process through the shared subagent runner.
- **WSL2**: runs `deyin run --json -y` inside a distro via `wsl.exe -d <distro>`. Distros come from the same detection the terminal uses; workspace paths are translated from Windows/UNC form to the distro's Linux form. Needs Node 20+ and the `deyin` CLI installed inside the distro.
- **Remote (SSH)**: connects to a Linux server and runs `deyin run --json -y` with the Openference account token via `DEYIN_TOKEN` (ephemeral per-run; never stored on the server). Custom providers are not supported for SSH or WSL targets.
- Triggers: cron schedules (hourly, daily, weekdays, custom) or manual **Run now**.
- SSH host credentials (private keys, passphrases, passwords) are encrypted at rest via OS keychain (`safeStorage`). Host keys are pinned on first connect.
- Configure SSH hosts under Settings → SSH hosts; manage automations from the sidebar **Automations** view (desktop only).
- Optional **Keep running in background** (General settings) keeps the scheduler alive in the system tray when windows are closed.
- Scheduling is in-process, so runs only fire while Deyin is running and the machine is awake. **Catch up missed automations** re-evaluates on launch and on system resume, and starts **exactly one** run for the most recently missed slot within the last seven days — a daily automation that missed six days runs once, not six times. If timing matters, put guardrails in the prompt itself.
- Unattended runs skip permission prompts, but not unconditionally: OS input synthesis (`computer_*`) and browser navigation are denied rather than auto-allowed, because there is no user present to answer. `deny` always beats skip-all in the permission engine. Workspace-provided `hooks.json` and `mcp.json` are ignored unless that workspace was already trusted through an interactive session, since an unattended run cannot show the trust dialog.
- Note: for both SSH and WSL targets the token and prompt are streamed over the child's stdin, so they never appear in the command line (`/proc/<pid>/cmdline`) or in the login shell's environment. `DEYIN_TOKEN` is still present in the `deyin` child process environment while a run is active, so treat the SSH host — or the distro — as a trusted machine. The remote command runs under a job-control shell that traps `EXIT`/`HUP` and kills its whole process group, so a dropped connection or a stopped run leaves no orphaned `deyin` process.

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
- Catalog source of truth: `apps/desktop/src/main/mcp-catalog/*.json` (one file per server).

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
- Catalog entries are classified: chat models stream completions, and
  text-to-image models are tagged **Image** in the picker.
- Image attachments always go to the model you picked — the client never
  gatekeeps on catalog metadata. If a model can't take images, the provider
  returns its own error, which surfaces in the timeline like any other
  provider failure. The optional **Local Vision** plugin (Ollama +
  `moondream`, ~1.7 GB) describes pictures on-device when your model has no
  vision.

## Image generation
- Image ability is read off the `/v1/models` catalog (`host-core/src/images.ts`,
  `modelImageCapability`): OpenRouter-style `architecture.output_modalities` and
  `modality: "text->image"` arrows, flat `output_modalities`/`type`/`capabilities` tags,
  with a curated id heuristic only when the catalog says nothing. Three outcomes:
  - **endpoint** — a text-to-image model (SDXL, FLUX, DALL·E, gpt-image) called on
    `POST /images/generations`; tagged **Image** in the picker.
  - **chat** — a chat model that draws inside its completion (Gemini flash-image /
    nano-banana); tagged **Draws**, streams normally, and keeps conversation context.
  - **none** — text-only.
- Picking an image model in the composer sends the prompt straight to the provider's
  OpenAI-compatible `/images/generations` endpoint — no chat completion involved.
- Running on a model that draws sets `modalities: ["text","image"]` (chat completions) or
  the built-in `image_generation` tool (Responses API). Pictures that come back attached
  to the assistant message — `delta.images`, image content parts, Responses
  `image_generation_call`, Anthropic image blocks — are detected in the stream
  (`host-core/src/image-parts.ts`), stored, and embedded in the reply automatically.
- The agent can also generate pictures mid-task with the `generate_image` tool: prompt,
  model, size, `n`, negative prompt, plus `input_images` (edit an image from the thread or
  a workspace path, via `/images/edits` or a drawing chat model) and `save_to` (write the
  picture into the workspace, e.g. `assets/hero.png`). Images the user attaches are stored
  too, so "make this darker" can reference them by file name.
- The tool is only offered when the signed-in catalog actually has an image-capable model;
  otherwise it is unregistered so the model cannot promise a picture it cannot draw. The
  built-in `/generate-image` skill covers routing, prompt craft, editing and iteration.
- Results are stored per thread (desktop: `userData/images/<thread>`, web: inside the
  session sandbox) and embedded in the reply as `::deyin-inline-image{file="…" alt="…"}`,
  which the chat renders as an inline picture, lazily decoded when it scrolls into view.

## Video generation
- Video models are classified from the `/v1/models` catalog (`host-core/src/videos.ts`,
  `isVideoModel`): output modality `video`, capability tags like `text-to-video`, and
  id heuristics (`agnes-video`, `Agnes-Video-2.5-Flash`, etc.). Tagged **Video** in
  the picker; they use `POST /v1/videos`, not chat completions.
- Picking a video model sends the prompt straight to the videos endpoint. The client
  polls until the async task completes, downloads the result, stores it per thread
  (desktop: `userData/videos/<thread>`, web: session sandbox + optional R2), and
  embeds `::deyin-inline-video{file="…"}` — rendered as an inline player with expand
  and download controls.
- **Agnes video settings** (composer bar): aspect ratio, frame count / duration presets,
  frame rate, inference steps, seed, mode (text-to-video, image-to-video, keyframes),
  negative prompt. Saved as `videoModelParams` keyed by `providerId::modelId`.
- **Auto generate videos** (`autoVideoGeneration`, Settings → General): when enabled,
  prompts like “generate a video of…” on a text-only model route to the first video
  model in the catalog.
- Image-to-video: reference images attached in the composer are sent with the video
  request when generating from a video model.
