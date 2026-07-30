# Feature Parity Status

An honest map of Deyin's original implementation against the agentic-development-environment
capability surface. "Foundation" means the plumbing exists and is wired end to end but the
full UX is not yet fleshed out. Nothing here reuses any proprietary code.

| Capability | Status | Where |
| --- | --- | --- |
| Openference OAuth sign-in | Done | `@deyin/oauth-provider`, `@deyin/oauth-client`, `main/auth.ts`, `client/transport.ts` |
| Reusable OAuth for other CLIs | Done | `@deyin/oauth-client` + `examples/cli-login.ts` |
| Profile menu (name/email/avatar/plan) | Done | `renderer/components/ProfileMenu.tsx` |
| Multi-model picker (`/v1/models`) | Done | `main/models.ts`, `client/transport.ts`, `components/ModelPicker.tsx` |
| Streaming agent chat | Done | `renderer/api/openference.ts`, `renderer/app.tsx` |
| 3-pane workspace shell (sidebar / chat / panel) | Done | `renderer/app.tsx`, `components/TopBar.tsx`, `styles.css` |
| Custom title bar + window controls | Done | `components/TopBar.tsx`, `main/window.ts` (frameless), `main/ipc.ts` (`win:*`) |
| Session timeline cards (plan, file change, model switch, skill, thought) | Done | `components/ChatView.tsx`, `renderer/threads.ts` |
| Composer: + insert menu, access mode, model, auto-run | Done | `components/Composer.tsx` (approval mode persisted in settings) |
| Composer modes: Agent / Plan / Ask (Shift+Tab cycle, Ctrl+. menu) | Done (desktop; web falls back to plain chat) | `components/Composer.tsx`, `main/agent.ts` (`agentForMode`), `agent-core/agents.ts` |
| Mode/access split enforced in the permission engine (plan/ask read-only even at full access) | Done | `main/agent.ts` (`PermissionEngine` layering), `agent-core/permissions.ts` |
| Plan mode UX: plan doc to Plan tab + Build handoff to Agent mode | Done | `app.tsx` (`buildFromPlan`), `components/ChatView.tsx` (`PlanReadyCard`), `WorkspacePanel.tsx` |
| Markdown chat output (GFM tables, themed code blocks) | Done | `components/Markdown.tsx` (react-markdown + remark-gfm over the custom `CodeBlock`) |
| Reasoning ("thinking") cards, live + collapsed with duration | Done | `components/ChatView.tsx` (`ThinkingCard`), `app.tsx` (reasoning-delta handling) |
| File-change cards with +/− counts feeding the Diff tab | Done | `agent-core` `file-change` event, `main/agent.ts` forward, `app.tsx` (`diffStats`) |
| Projects / threads sidebar | Done (in-memory; persistence pending) | `components/Sidebar.tsx`, `renderer/threads.ts` |
| Workspace panel: Plan tab | Done (agent-fed live stream + todos) | `components/WorkspacePanel.tsx`, `app.tsx` (`planStream`) |
| Workspace panel: Diff tab | Done (LCS line diff + source preview) | `components/WorkspacePanel.tsx`, `renderer/diff.ts` |
| Workspace panel: Browser tab | Done | `components/WorkspacePanel.tsx` (`<webview>` desktop, iframe web) |
| Settings: General (live i18n en/zh/de, auto-update, telemetry, agent mode) | Done | `components/settings/GeneralPage.tsx`, `host-core/src/i18n.ts`, `host-core/src/telemetry.ts` |
| Settings: Appearance (interface font size, real code theme palettes + highlighter) | Done | `settings/AppearancePage.tsx`, `renderer/code.tsx` |
| Settings: Model providers (plan display, 1-week model cache, draft add form) | Done | `settings/ModelSettingsPage.tsx`, `host-core/src/stores.ts` (`AccountCache`, `ModelsCache`) |
| Settings: Browser control + clear data | Done | `components/settings/BrowserPage.tsx`, `main/ipc.ts` (`browser:*`) |
| Settings: Terminal (default shell incl. WSL2, font size, scrollback, reveal on agent command) | Done | `components/settings/TerminalPage.tsx` |
| Settings: Skills / Subagents / Commands / Hooks (live `.deyin` registry) | Done | `settings/CapabilityPage.tsx`, `agent-core/src/capabilities/*`, `main/capabilities.ts` |
| Built-in default skills (13, materialized + overridable) | Done | `agent-core/src/capabilities/builtin-skills.ts` |
| Settings: MCP servers (list/add/remove/test, stdio+SSE+HTTP) | Done | `settings/McpPage.tsx`, `agent-core/src/mcp.ts` |
| Settings: Plugins (GitHub install, DeYinAI catalog, secret variables) | Done | `settings/PluginsPage.tsx`, `main/plugins.ts`, `agent-core/src/capabilities/plugin-install.ts` |
| Settings: Indexing (live local semantic index + search probe) | Done | `settings/IndexingPage.tsx`, `host-core/src/indexer/*` |
| Settings: Usage stats (cards, heatmap, per-day chart, cached account snapshot) | Done | `components/settings/UsageStatsPage.tsx`, `main/usage.ts` |
| Settings: Onboard checklist (computed from real state, persisted) | Done | `components/settings/OnboardPage.tsx` |
| Environment detection (Local / WSL2) | Done | `main/host/env.ts`, `components/EnvironmentBadge.tsx` |
| Terminal (PTY, tabs, shell picker incl. WSL2 distros) | Done (needs `node-pty` built) | `host-core/src/host/pty.ts`, web `server/host.ts`, `components/TerminalPanel.tsx` |
| Agent persistent PTY + live tool output + attachable Agent tab | Done (needs `node-pty` built) | `host-core/src/host/agent-shell.ts`, `main/agent.ts`, `tool-delta` / `shell-session` events, `TerminalPanel` attach |
| Two-level model picker (providers → models, Manage models) | Done | `components/ModelPicker.tsx` |
| Custom providers: base URL, API format, encrypted API key, model list CRUD, connection test | Done | `main/agents.ts` (safeStorage keys), `settings/ModelSettingsPage.tsx` |
| Per-provider chat routing (Openference OAuth or custom key) | Done | `renderer/app.tsx` `send()` |
| Thinking toggle (persisted, sent as `reasoning`) | Done | `components/Composer.tsx`, `api/openference.ts` |
| Appearance: code themes, line numbers, wrap, code font size + previews | Done | `settings/AppearancePage.tsx`, wired into Diff tab |
| Dark + light interface themes (live switch, "system" follows OS) | Done | `packages/branding/src/tokens.ts` (dual palettes), `app.tsx` theme effect |
| Rounded card layout (line-free sidebar, floating content card) | Done | `renderer/styles.css` surface model |
| Task context menu (pin/rename/archive/unread, copy paths/session ID, open in file manager, report issue) | Done | `components/ThreadMenu.tsx`, `TopBar.tsx`, `Sidebar.tsx` |
| Built-in free web search (DuckDuckGo, keyless) + Ctrl+K overlay | Done | `main/search.ts`, web `server/index.ts` `/api/search`, `components/SearchOverlay.tsx` |
| Desktop agent runtime (tool-calling loop, approvals, sessions) | Done | `main/agent.ts` hosting `@deyin/agent-core` (`runAgent`), `components/ApprovalDialog.tsx` |
| Settings: reveal terminal on agent command | Done | `settings/TerminalPage.tsx` (`revealTerminalOnAgentCommand`) |
| Skills (SKILL.md discovery, prompt injection, /skill invoke, built-in defaults) | Done | `agent-core/src/capabilities/skills.ts`, `builtin-skills.ts` |
| Commands ($ARGUMENTS templates + composer autocomplete) | Done | `agent-core/src/capabilities/commands.ts`, `components/Composer.tsx` |
| Subagents (task tool, clean context, fg/bg, readonly) | Done | `agent-core/src/tools/task.ts`, `main/agent.ts` |
| Hooks (hooks.json, stdio JSON, exit-2 block, fail-open) | Done | `agent-core/src/capabilities/hooks.ts` |
| MCP client (stdio + SSE + Streamable HTTP, mcp.json + interpolation) | Done | `agent-core/src/mcp.ts`, `agent-core/src/capabilities/mcp-config.ts` |
| Plugins (GitHub tarball install, auto-discovery, variables) | Done | `agent-core/src/capabilities/plugins.ts`, `plugin-install.ts`, `main/plugins.ts` |
| Live local semantic index + `codebase_search` tool | Done | `host-core/src/indexer/*`, `agent-core/src/tools/codebase-search.ts` |
| Browser control (CDP navigate/click/type/screenshot/console/network, per-workspace profile) | Done | `main/browser.ts`, `components/WorkspacePanel.tsx` |
| File explorer / read | Foundation | `main/host/files.ts`, web `server/host.ts` (tree/read wired; UI panel pending) |
| Workspace / open folder | Foundation | `main/ipc.ts` (`workspace:open`) |
| Goal mode / automations engine | Shipped (desktop) | cron + manual; local or SSH |
| Agent runtime on the web (WS channel to the session host) | Planned | web falls back to plain chat streaming today |
| OS-level computer use | Out of scope for now | browser control covers in-app automation |
| Web hosting (same renderer) | Done | `@deyin/web` reuses `apps/desktop/src/renderer` verbatim |
| Auto-update | Done (packaged builds) | `main/updater.ts` |

## Verification

`bash scripts/verify.sh` builds every package, typechecks all six workspaces, runs the
OAuth unit + integration tests, and builds both apps. CI runs the same script.

## What "1:1" means here

Deyin targets **functional and visual parity** with a modern ADE, implemented as original
code Deyin owns and can host on the web. It is intentionally **not** a byte-for-byte copy of
any proprietary desktop bundle: that could not be legally redistributed, would break on
every upstream release, and could not be adapted to run in a browser. The planned items
above are product work on this foundation, not blocked by any missing third-party artifact.
