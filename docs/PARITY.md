# Feature Parity Status

An honest map of Deyin's original implementation against the agentic-development-environment
capability surface. "Foundation" means the plumbing exists and is wired end to end but the
full UX is not yet fleshed out. All implementation here is original Deyin code.

| Capability | Status | Where |
| --- | --- | --- |
| Openference OAuth sign-in | Done | `@deyin/oauth-provider`, `@deyin/oauth-client`, `main/auth.ts`, `client/transport.ts` |
| Reusable OAuth for other CLIs | Done | `@deyin/oauth-client` + `examples/cli-login.ts` |
| Profile menu (name/email/avatar/plan) | Done | `renderer/components/ProfileMenu.tsx` |
| Plans & billing (catalog, checkout, downgrade, cross-currency) | Done | `components/PlansView.tsx`, `host-core/src/billing*.ts`, `renderer/billing/*` |
| Multi-model picker (`/v1/models`) | Done | `main/models.ts`, `client/transport.ts`, `components/ModelPicker.tsx` |
| Streaming agent chat | Done | `renderer/api/openference.ts`, `renderer/app.tsx` |
| 3-pane workspace shell (sidebar / chat / panel) | Done | `renderer/app.tsx`, `components/TopBar.tsx`, `styles.css` |
| Custom title bar + window controls | Done | `components/TopBar.tsx`, `main/window.ts` (frameless), `main/ipc.ts` (`win:*`) |
| Session timeline cards (plan, file change, model switch, skill, thought) | Done | `components/ChatView.tsx`, `renderer/threads.ts` |
| Composer: + insert menu, access mode, model, auto-run | Done | `components/Composer.tsx` (approval mode persisted in settings) |
| Composer modes: Agent / Plan / Ask (Shift+Tab cycle, Ctrl+. menu) | Done (shared; web runs the same plan/ask agents in the session sandbox) | `components/Composer.tsx`, `main/agent.ts` (`agentForMode`), `agent-core/agents.ts`, `apps/web/src/server/agent-host.ts` |
| Mode/access split enforced in the permission engine (plan/ask read-only even at full access) | Done | `main/agent.ts` (`PermissionEngine` layering), `agent-core/permissions.ts` |
| Plan mode UX: plan doc to Plan tab + Build handoff to Agent mode | Done | `app.tsx` (`buildFromPlan`), `components/ChatView.tsx` (`PlanReadyCard`), `WorkspacePanel.tsx` |
| Markdown chat output (GFM tables, themed code blocks) | Done | `components/Markdown.tsx` (react-markdown + remark-gfm over the custom `CodeBlock`) |
| Reasoning ("thinking") cards, live + collapsed with duration | Done | `components/ChatView.tsx` (`ThinkingCard`), `app.tsx` (reasoning-delta handling) |
| File-change cards with +/− counts feeding the Diff tab | Done | `agent-core` `file-change` event, `main/agent.ts` forward, `app.tsx` (`diffStats`) |
| Projects / threads sidebar | Done (persisted via ProjectsStore) | `components/Sidebar.tsx`, `renderer/threads.ts`, `host-core/src/stores.ts` |
| Workspace panel: Plan tab | Done (agent-fed live stream + todos) | `components/WorkspacePanel.tsx`, `app.tsx` (`planStream`) |
| Workspace panel: Diff tab | Done (LCS line diff + source preview + review Accept/Reject) | `components/WorkspacePanel.tsx`, `renderer/diff.ts`, `components/ReviewBanner.tsx` |
| Workspace panel: Git tab | Done (status, stage, commit, branches, log; web via sandbox git RPCs) | `components/GitTab.tsx`, `host-core/src/host/git.ts`, `main/ipc.ts`, `apps/web/src/server/session.ts` |
| Web repo workflow (connect URL → work branch → Ship button: commit/push/merge, PR-link fallback) | Done (web) | `apps/web/src/server/repo.ts`, `components/RepoBar.tsx`, `client/transport.ts` (`repo` API) |
| Vision: image attach (paste/drag/pick) routed to a vision-capable model in the user's plan | Done (shared pipeline, all 3 wire formats) | `components/Composer.tsx`, `vision.ts`, `host-core/src/models.ts` (`modelSupportsVision`), `agent-core/src/wire.ts` |
| Text-to-image: image models in the picker + `generate_image` tool, pictures rendered inline in chat | Done (desktop + web) | `host-core/src/images.ts` (`modelImageCapability`, `generateImages`), `host-core/src/host/image-store.ts`, `agent-core/tools/generate-image.ts`, `components/InlineImage.tsx`, `client/embeds.ts`, `main/image-gen.ts`, `apps/web/src/server/session.ts` |
| Image output from chat models that draw (Gemini flash-image / nano-banana, Responses image tool): detected from the catalog, captured from the stream, stored and embedded | Done (desktop + web, all 3 wire formats) | `host-core/src/image-parts.ts`, `host-core/src/host/image-bridge.ts`, `agent-core/src/stream.ts`, `agent-core/src/transports.ts`, `agent-core/src/loop.ts` |
| Image editing (`input_images`) and saving generated pictures into the workspace (`save_to`) | Done (desktop + web) | `host-core/src/host/image-bridge.ts`, `host-core/src/images.ts` (`/images/edits`), `agent-core/src/tools/generate-image.ts` |
| Composer: @ file/folder context chips + resolver | Done | `components/Composer.tsx`, `host-core/src/context-refs.ts`, `app.tsx` |
| Composer: # linked thread context | Done | `components/Composer.tsx`, `host-core/src/linked-thread-context.ts` |
| Change review before apply | Done | `main/pending-review.ts`, `agent-core/src/tools/file-mutation.ts`, `ReviewBanner.tsx` |
| Goal mode (UI modal + report_goal_met tool) | Done | `agent-core/src/tools/report-goal-met.ts`, `Composer.tsx`, `app.tsx` |
| Workspace panel: Browser tab | Done | `components/WorkspacePanel.tsx` (`<webview>` desktop, iframe web) |
| Settings: General (live i18n en/zh/de, auto-update, telemetry, agent mode) | Done | `components/settings/GeneralPage.tsx`, `host-core/src/i18n.ts`, `host-core/src/telemetry.ts` |
| Settings: Appearance (interface font size, real code theme palettes + highlighter) | Done | `settings/AppearancePage.tsx`, `renderer/code.tsx` |
| Settings: Model providers (plan display, 1-week model cache, draft add form) | Done | `settings/ModelSettingsPage.tsx`, `host-core/src/stores.ts` (`AccountCache`, `ModelsCache`) |
| Settings: Browser control + clear data | Done | `components/settings/BrowserPage.tsx`, `main/ipc.ts` (`browser:*`) |
| Settings: Terminal (default shell incl. WSL2, font size, scrollback, reveal on agent command) | Done | `components/settings/TerminalPage.tsx` |
| Settings: Skills / Subagents / Commands / Hooks (live `.deyin` registry) | Done | `settings/CapabilityPage.tsx`, `agent-core/src/capabilities/*`, `main/capabilities.ts` |
| Built-in default skills (13, materialized + overridable) | Done | `agent-core/src/capabilities/builtin-skills.ts` |
| Settings: MCP servers (list/add/remove/test, stdio+SSE+HTTP) | Done | `settings/McpPage.tsx`, `agent-core/src/mcp.ts` |
| Settings: MCP catalog (browse, install, secrets, native OAuth) | Done | `settings/McpPage.tsx`, `main/mcp-catalog.ts`, `main/mcp-modules.ts`, `main/mcp-oauth.ts`, `main/mcp-catalog/*.json` |
| MCP per-module install (`~/.deyin/mcp-modules/<id>/`) | Done | `main/mcp-modules.ts`, `agent-core/capabilities/mcp-config.ts` |
| Goal modal + clear goal | Done | `components/Composer.tsx` |
| Context attachment budget warning | Done | `components/Composer.tsx`, `components/ContextUsage.tsx` |
| Chat history attachment / linked-thread chips | Done | `components/ChatView.tsx` |
| Tray pending-review indicator | Done | `main/tray.ts`, `main/ipc.ts` |
| Reject-all / approve-all review sync | Done | `main/agent.ts`, `main/pending-review.ts` |
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
| File explorer / read | Done | `components/WorkspacePanel.tsx` (Files tab), `main/host/files.ts`, `host-core/src/context-refs.ts`, web `server/host.ts` |
| Workspace folder picker (open/switch) | Done | `components/project-picker/*`, `main/remote/workspace-service.ts`, `main/ipc.ts` |
| Remote SSH workspace (files/git read, SFTP writes) | Done (foundation) | `host-core/src/host/remote-backend.ts`, `main/remote/connection-pool.ts` |
| Desktop git clone from URL / GitHub | Done | `host-core/src/host/repo-manager.ts`, `main/github.ts`, `ProjectPicker.tsx` |
| Agent runtime on the web (WS channel to the session host) | Done | `apps/web/src/server/agent-host.ts` runs `@deyin/agent-core` in the session sandbox; events stream over `agent.event` WS pushes using the desktop-shaped `AgentEventEnvelope` |
| Inline visualizations | Done | `visualize_write` tool, path-safe read/write, tightened CSP in `InlineVisualization.tsx` |
| Security findings panel | Done | `SecurityFindingsPanel.tsx`, semgrep/npm audit MCP, workspace-bounded scans |
| Security scan plugin | Done (MVP) | bundled `security` plugin + MCP `deyin-security` |
| Bundled first-party plugins | Done | `apps/desktop/bundled-plugins/`, materialize on startup, marketplace cards |
| Web hosting (same renderer) | Done | `@deyin/web` and `@deyin/desktop` both build the `@deyin/ui` renderer package |
| Plugin kernel (seams: tools, llm, caps, optimization) | Done | `@deyin/extension-api`, `@deyin/kernel`, `@deyin/tools` + 6 family plugins, `@deyin/llm` + 3 adapters, `@deyin/plugin-caps-local` |
| Config-layer composition (bundles → profiles → patches) | Done | `@deyin/bundle-base`, `@deyin/bundle-desktop-app`, `@deyin/bundle-web-app`, `@deyin/bundle-headless`; `kernel.dumpConfig()` |
| Kernel plugin status in Plugins settings | Done | `main/agent.ts` (`kernelReady`), `CH.pluginsKernelStatus`, `settings/PluginsPage.tsx` ("Kernel plugins") |
| Web sandbox capabilities (skills/commands/subagents in `.deyin`) | Done | `apps/web/src/server/agent-host.ts` kernel + `@deyin/plugin-caps-local` scoped to the sandbox |
| Session event log spine (primary store: replay, fork, migration) | Done | `agent-core/src/session.ts` (`events()`, `fork()`, lifecycle events), `test/session-log.test.ts`, migration suite |
| Session event journal (web sandbox UI events) | Done | `host-core/src/session-journal.ts`, journaled in `agent-host.ts` `emit()` |
| Auto-update | Done (packaged builds) | `main/updater.ts` |

## Verification

`bash scripts/verify.sh` builds every package, typechecks all six workspaces, runs the
OAuth unit + integration tests, and builds both apps. CI runs the same script.

## What "1:1" means here

Deyin targets **functional and visual parity** with a modern ADE, implemented as original
code Deyin owns and can host on the web. The planned items above are product work on this
foundation.
