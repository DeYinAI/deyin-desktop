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
- Execution modes cycled with a shortcut: from "ask before every action" through to
  "full access". The mode gates whether the agent may edit files or run commands without
  a confirmation.
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
- Sources: user global (`~/.deyin/skills`), project (`.deyin/skills`), and plugin-provided.
- Import from other agents' skill directories (Claude Code, Codex, etc.) by copy or symlink.
- Invoke in chat with `$skill-name`.

## Plugins
- A plugin bundles skills, slash commands, subagents, MCP servers, hooks, and LSP configs.
- Enable/disable per workspace. Enabled plugins contribute their components automatically.

## Automations
- Scheduled or event-triggered prompts (cron-like recurrence or file/git events).
- Each automation is a saved prompt + trigger + target project.

## MCP
- Connect Model Context Protocol servers; discover and call their tools from chat.

## Identity & billing
- Sign in with Openference (OAuth 2.0 + PKCE). Profile menu shows name, email, avatar, plan.
- The same access token authorizes model calls; no separate API key entry required.

## Multi-model
- Model picker backed by Openference's live `/v1/models` catalog.
