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
| Projects / threads sidebar | Done (in-memory; persistence pending) | `components/Sidebar.tsx`, `renderer/threads.ts` |
| Workspace panel: Plan tab | Done (static plan; agent-fed later) | `components/WorkspacePanel.tsx` |
| Workspace panel: Diff tab | Done (LCS line diff + source preview) | `components/WorkspacePanel.tsx`, `renderer/diff.ts` |
| Workspace panel: Browser tab | Done | `components/WorkspacePanel.tsx` (`<webview>` desktop, iframe web) |
| Settings: General / Appearance | Done | `components/settings/GeneralPage.tsx`, `AppearancePage.tsx` |
| Settings: Model providers (+ add custom) | Done | `components/settings/ModelSettingsPage.tsx`, `main/agents.ts` |
| Settings: Browser control + clear data | Done | `components/settings/BrowserPage.tsx`, `main/ipc.ts` (`browser:*`) |
| Settings: Plugins / Skills / Subagents / MCP / Commands / Hooks | Done (registry + toggles) | `components/settings/CapabilityPage.tsx`, `main/agents.ts` |
| Settings: Indexing | Done (file count; semantic index later) | `components/settings/IndexingPage.tsx` |
| Settings: Usage stats (cards, heatmap, per-day chart) | Done | `components/settings/UsageStatsPage.tsx`, `main/usage.ts` |
| Environment detection (Local / WSL2) | Done | `main/host/env.ts`, `components/EnvironmentBadge.tsx` |
| Terminal (PTY, tabs, shell picker incl. WSL2 distros) | Done (needs `node-pty` built) | `main/host/pty.ts`, web `server/host.ts`, `components/TerminalPanel.tsx` |
| Two-level model picker (providers → models, Manage models) | Done | `components/ModelPicker.tsx` |
| Custom providers: base URL, API format, encrypted API key, model list CRUD, connection test | Done | `main/agents.ts` (safeStorage keys), `settings/ModelSettingsPage.tsx` |
| Per-provider chat routing (Openference OAuth or custom key) | Done | `renderer/app.tsx` `send()` |
| Thinking toggle (persisted, sent as `reasoning`) | Done | `components/Composer.tsx`, `api/openference.ts` |
| Appearance: code themes, line numbers, wrap, code font size + previews | Done | `settings/AppearancePage.tsx`, wired into Diff tab |
| Dark + light interface themes (live switch, "system" follows OS) | Done | `packages/branding/src/tokens.ts` (dual palettes), `app.tsx` theme effect |
| Rounded card layout (line-free sidebar, floating content card) | Done | `renderer/styles.css` surface model |
| Task context menu (pin/rename/archive/unread, copy paths/session ID, open in file manager, report issue) | Done | `components/ThreadMenu.tsx`, `TopBar.tsx`, `Sidebar.tsx` |
| Built-in free web search (DuckDuckGo, keyless) + Ctrl+K overlay | Done | `main/search.ts`, web `server/index.ts` `/api/search`, `components/SearchOverlay.tsx` |
| Search exposed as MCP entry (`deyin-search`) | Done (registry entry; MCP protocol serving later) | `main/agents.ts` |
| Browser control (navigate/execute/screenshot on the built-in tab) | Done (plumbing, gated by setting) | `components/WorkspacePanel.tsx` (`window.deyinBrowser`) |
| File explorer / read | Foundation | `main/host/files.ts`, web `server/host.ts` (tree/read wired; UI panel pending) |
| Workspace / open folder | Foundation | `main/ipc.ts` (`workspace:open`) |
| Goal mode / automations engine | Planned | flag off by default |
| Live agent-driven edits (real diffs/plans from runs) | Planned | timeline + diff UI ready to receive them |
| MCP client (spawn configured servers) | Planned | registry exists in `main/agents.ts` |
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
