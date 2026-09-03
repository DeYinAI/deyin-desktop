# Changelog

All notable **public** releases are documented here.

**v1.0.0 is the first public open-source release.** Earlier versions (0.x–2.1.x)
were private beta builds; their release assets have been removed from GitHub.
See [archive/](./archive/) for pre-v1 internal notes.

## 1.0.14 — 2026-09-03

### Highlights

- Hotfix: threads with an attached screenshot could die permanently — every
  later message replayed the image to text-only models (GLM answers with
  error 1210) and failed identically; the request now self-heals by retrying
  without image parts, so the conversation keeps working
- Background commands that finish quickly (echo, file probes) are no longer
  reported as "Unknown background task" with their output lost — settled
  results stay pollable for a grace window
- Browser tool: `file://` and localhost/dev-server URLs are no longer forced
  to `https://` (which could never work); screenshots now come back as
  inline-image directives rendered in chat instead of a binary file the agent
  cannot read
- Settings: the last unstyled dropdowns (Computer Use page, image-model menu)
  now match the upgraded select styling

## 1.0.13 — 2026-09-03

### Highlights

- Settings → Models: the Openference card now live-updates to connected after
  sign-in (was stuck on "Not connected" until you left the page) and, once
  connected, shows the plan name, weekly reset date and a quota grid — 5-hour
  window, this week, requests today, credits
- "Renew / change plan" opens the in-app plan picker; "Manage billing" opens
  the portal's billing overview
- Plans support a forward-compatible `isSoldOut` flag: sold out plans render a
  localized badge and a disabled CTA (public catalog API omits the flag today;
  absent means available)
- Tooling: the bash tool description no longer tells agents to avoid `&&` on
  WSL-backed Windows sessions, and commands that finish before the persistent
  shell starts capturing output are labeled for retry instead of reading as
  "printed nothing"

## 1.0.12 — 2026-09-02

### Highlights

- Hotfix: blank screen on New Chat (and on startup thread-list hydration) — a timeline memoisation hook sat after ChatView's empty-state early return, so the first empty↔populated transition crashed the renderer with React error #300; hooks now run before the branch and the renderer is lint-guarded by `react-hooks/rules-of-hooks` so a conditional hook cannot ship again

## 1.0.11 — 2026-09-02

### Highlights

- Context engine: structured compaction briefings with a live context meter; the verbatim tail now scales with the model's window so small context windows keep folding viable
- Compaction reliability: failed fold summaries are receipt-gated — a summarizer that cannot shrink the transcript is paid for once per run instead of once per step; surfaced as `fold-failed` in the UI and run summaries
- Snipped tool results are no longer lost: the full raw text is retained (bounded) and pageable back with `read_session_context (tool_call_id=…)` instead of re-running the tool
- Loop guard (error storms, blocked streaks, repeated writes, no-progress nudges), tool-result deduplication with head/tail snipping, and per-run summaries (denied/failed/duplicate calls, guard trips, cache hit rate) with `runs:summary` aggregation
- Composer dock with draft persistence and per-thread queue bars
- New compaction benchmark (cost + fidelity arms) guarding policy actions, prune idempotency, tail scaling, and fold fidelity; results tracked in PERFORMANCE_REPORT.md

## 1.0.3 — 2026-08-26

### Highlights

- Core chat & tools stabilization: register `complete_step` and `wait` in the plugin catalog; wire background job collection via `JobsManager`
- Per-thread composer isolation: concurrent agent runs no longer wedge the composer or share approval/queue state
- Local Vision (Ollama moondream): optional on-device image description when cloud vision is unavailable
- Agent startup hardening: duplicate-run and unexpected failures always emit `done` so the UI recovers
- Catalog parity test guards against silent tool drops after plugin-seam migrations

## 1.0.2 — 2026-08-25

### Highlights

- Computer-use sidecar fix: spawn with correct working directory so the Windows host can load and open the named pipe
- Computer-use diagnostics: sidecar stderr logged to `%APPDATA%\Deyin\computer-use\host.log`; Settings host status shows log path
- Update notice moved to a compact sidebar pill (Cursor-style) instead of a full-width top banner
- Pre-ship security audit skill bundled in the security plugin

## 1.0.1 — 2026-08-24

### Highlights

- Remote SSH workspaces with project picker (clone, browse, recent workspaces)
- Model reasoning options and chat UI improvements
- Computer-use host reliability fixes

## 1.0.0 — 2026-08-23

First public open-source release under the PolyForm Noncommercial License 1.0.0.

### Highlights

- Agentic IDE: desktop (Electron), web, and CLI with Openference OAuth
- Plugin system (GitHub install + bundled browser, computer-use, security, visualize)
- MCP catalog with OAuth support
- CI/CD: verify, CodeQL, Dependabot, Openference AI PR review
- Release builds: Linux + Windows installers from dell-runner; CLI binaries for all platforms
- In-app updates via public [DeYinAI/deyin-releases](https://github.com/DeYinAI/deyin-releases)

### Distribution

- Desktop: GitHub Releases + auto-update feed
- CLI: GitHub Release binaries + `scripts/install.sh`
- Content plugins: GitHub + [DeYinAI/registry](https://github.com/DeYinAI/registry)
- Kernel packages: monorepo source only (not on npm)

See [PLUGINS_AND_MCP.md](./PLUGINS_AND_MCP.md) and [RELEASE.md](./RELEASE.md) for details.
