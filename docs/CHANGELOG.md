# Changelog

All notable **public** releases of Deyin are documented here.

> **Note on Versioning History:**
> Prior to the official public open-source release on August 23, 2026, the codebase used internal pre-release milestone tags (`v0.x` and `v2.0.0`–`v2.1.10` private beta builds). For the public launch, versioning was formally reset to **v1.0.0** to establish a clean, standard Semantic Versioning baseline. All public production releases follow the continuous `v1.0.x` release line (`v1.0.0` → `v1.0.23`). Pre-v1 beta notes are archived at the bottom of this document and under [`docs/archive/`](./archive/).

## 1.0.23 — 2026-09-20

### Highlights

- **Unified Modal Overlay Management in Project Selector:** Resolved double-overlay
  collision where the main project/folder search dialog remained visible beneath child
  dialogs (WSL/local folder browser, clone repository, SSH connect, and GitHub browser).
  Sub-dialogs now cleanly take over the viewport with proper modal hierarchy and backdrop isolation.
- **Robust Multi-Platform Breadcrumb & Path Navigation:** Overhauled path parsing and
  traversal in the folder browser dialog to natively handle Windows drive paths (`C:\...`),
  WSL UNC paths (`\\wsl.localhost\...` and `//wsl.localhost/...`), network shares, and POSIX
  filesystems. Breadcrumb navigation now correctly resolves without leading slash corruption.
- **Enhanced Directory Selection & Keyboard Navigation:** Differentiated single-click
  selection from double-click folder drilling, complete with a dedicated chevron button for
  intuitive navigation. Added keyboard selection (Enter to select or drill, Esc with proper
  propagation to close only the active sub-modal) and prevented duplicate action dispatches.
- **Debounced Remote Repository Search & Request Race Guards:** Added request ID sequencing
  and stale-response guards across asynchronous directory listings and GitHub/SSH repository
  queries to eliminate out-of-order race conditions and UI flickering. Debounced repository
  search inputs to minimize remote API calls.
- **Refined WSL Path Display & Shortening:** Streamlined recent workspace labels for WSL
  environments, replacing cluttered raw UNC paths with distro-aware relative paths (e.g.,
  `~/...` with `WSL · Ubuntu-22.04` environment badge).
- **Accessible & Consistent Modal UI:** Standardized modal hierarchy, titles, summary subtitles,
  buttons, and scrolling list boxes to conform with native design standards and eliminate
  invalid nested interactive elements.

## 1.0.22 — 2026-09-20

### Highlights

- **Continuous Autonomous Execution:** Removed legacy turn-based step limits by
  default (`agentMaxSteps: null`), aligning with modern ADE architectures for
  uninterrupted multi-step problem solving. Added proactive warnings before finite
  step caps so agents wrap up cleanly while retaining robust loop guards against
  stalemates and repetition.
- **Active Goal Completion Gate:** Goal-driven sessions now enforce objective verification.
  If an active goal is set on the thread, the agent runtime verifies whether `report_goal_met`
  was called and nudges up to a bounded budget to prevent premature exits without verified progress.
- **Mid-Flight Steering:** Users can inject follow-up messages into an actively running
  agent session without aborting or restarting. The agent runtime drains queued steering
  messages dynamically between steps.
- **Compiler & LSP Diagnostic Feedback Loop:** Added automated diagnostic loopback that
  queries workspace compiler and LSP diagnostics on modified files after every step,
  feeding errors and warnings back to the model for instant self-correction.
- **On-Demand Diagnostics Tool:** Added the `diagnostics` tool to allow models to query
  language server errors, syntax issues, and type diagnostics across files or the entire workspace.
- **Subagent Resumption Flexibility:** The `task` tool now supports `task_id` and
  `session_id` as aliases for `resume`, facilitating smoother workflow chaining across subagents.
- **Dynamic In-App Release Notes:** Added an interactive "What's New" release notes modal
  with version badges, feature highlights, and direct synchronization from repository release notes.
- **Brand & Icon Refresh:** Modernized application mark, wordmark, and desktop/web icon
  suites with refreshed geometric branding.

## 1.0.21 — 2026-09-19

### Highlights

- **Promo Trial Plan Support:** Added support for the $1/mo Promo trial tier with
  curated model access (Qwen3.8 27B, Llama 3.2 3B) at 0.1 request credit cost;
  suppressed annual billing discounts on Promo to enforce trial limits
- **Purchase Agreement & Terms Confirmation:** Added mandatory Terms of Service
  and non-refundable policy confirmation dialog for all paid plan selections and
  billing cycle switches before checkout is initiated
- **Downgrade & Scheduled Cancellation:** Switching to Promo or Free from an
  active paid subscription schedules end-of-period cancellation with expiration
  badges and clear downgrade notifications
- **Billing Cycle Desync Prevention:** Fixed cycle inheritance so checkout
  and 3DS confirmation requests strictly match user-agreed billing terms
- **Durable Checkpoints Revert:** Durable checkpoint revert and edit-and-resend
  capabilities in chat sessions across Desktop and Web

## 1.0.20 — 2026-09-04

### Highlights

- **Fix:** Video generation sends required Agnes API fields (`mode`, `seconds`,
  `aspect_ratio`, `720P` size) — fixes HTTP 400 “mode is required” on
  `Agnes-Video-2.5-Flash`
- **Video settings** bar above the composer (like image quality): mode
  (text / reference / keyframe), duration 4–12s, aspect ratio, seed — aligned
  with [Agnes Video 2.5 Flash](https://www.agnes-ai.com/en/docs/agnes-video-25-flash)
  docs; visible on web chat and desktop when a video model is selected
- Reference and keyframe modes map composer attachments to `images[]`,
  `first_frame`, and `last_frame`; polling includes `model_name` for Agnes retrieval

## 1.0.19 — 2026-09-04

### Highlights

- **Fix:** `Agnes-Video-2.5-Flash` (and other video models) no longer get sent to
  chat completions when the model cache predates video classification — stale
  catalogs now backfill `kind: "video"` from the id heuristic, and send uses
  `modelIsVideo()` so video models always route to `POST /v1/videos`

## 1.0.18 — 2026-09-03

### Highlights

- **Files panel fix:** opening workspace files (e.g. from chat links or the file
  tree) no longer fails with “Path escapes workspace root” when paths use WSL
  UNC vs POSIX forms or remote workspace display labels

## 1.0.17 — 2026-09-03

### Highlights

- **Video generation** for text-to-video models (Agnes Video, etc.): picking a
  video model in the composer routes prompts to `POST /v1/videos` instead of chat
  completions, polls until the async job finishes, and embeds the result inline
  with a player and download button (`::deyin-inline-video{file="…"}`)
- **Agnes video settings** bar when a video model is selected: aspect ratio
  (16:9, 9:16, 1:1, 4:3, 3:4), duration (frame presets), frame rate, inference
  steps, seed, mode (text-to-video / image-to-video / keyframes), and negative
  prompt — saved per model in Settings
- **Auto generate videos** toggle in Settings → General (like auto image
  generation): “make me a video of…” on a text model routes to your video model
- Image-to-video: attach reference images in the composer when a video model is
  selected

## 1.0.16 — 2026-09-03

### Highlights

- Unified `User-Agent` header on every outbound HTTP request (LLM providers,
  Openference, GitHub, web search): `Deyin/{version} ({surface}; {platform}; {runtime})`
  — one identity per process, initialized at app startup for desktop, CLI, and web host

## 1.0.15 — 2026-09-03

### Highlights

- Agents can no longer finish a turn with the todo list left stale: when a
 final answer arrives while items are pending or in progress, the loop
 injects one bounded "[todo reconcile]" nudge asking the model to mark
 finished items completed (or cancel obsolete ones) and keep working;
 budgeted at 2 nudges per run, opt-out via `todoReconcile: false`
- The todo list now survives context compaction exactly: the fold briefing
 carries a deterministic, tracker-derived "Todo list (authoritative)"
 section (id + status per item) instead of the summariser guessing state
 from prose, so resumed sessions reconcile against reality

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

## 1.0.10 — 2026-09-01

### Highlights

- **Workspace trust gate:** Inline security trust prompt card in the renderer for untrusted workspaces (replacing native message boxes) with a configurable timeout
- **Unlimited agent steps:** Support `agentMaxSteps: null` for unbounded agent execution loops; exposed in Settings → General
- **Split diff view:** Side-by-side split diff mode in the workspace Diff tab alongside unified diff, sharing an LCS engine
- **Network resilience:** Automatic single-retry with exponential backoff on transient 408/429/5xx chat stream failures
- **OAuth session recovery:** Automatic session cleanup on `invalid_grant` / `invalid_client` to prevent permanently poisoned auth states

## 1.0.9 — 2026-08-31

### Highlights

- **CI & plugin parity:** Register `create_page` tool in plan tools plugin for catalog parity verification
- **Release update feed:** Ensure `make_latest` flag is set when publishing update feeds to `deyin-releases`

## 1.0.8 — 2026-08-31

### Highlights

- **Computer-use sidecar:** Fix pipe disposal race condition during fast disconnect/reconnect cycles
- **Security plugin:** Fix WSL path normalization and UNC path handling in security MCP server
- **Chat HTML preview:** Added inline HTML preview panel for chat-only web and desktop artifacts, with expandable long code blocks

## 1.0.7 — 2026-08-28

### Highlights

- **Web artifacts:** Added one-page website artifact generation backed by user-scoped Cloudflare R2 bucket storage
- **macOS packaging:** Fixed macOS packaging dependencies by bundling computer-use-host and desktop dependencies

## 1.0.6 — 2026-08-28

### Highlights

- **Native core fallback:** Made native-core Rust compilation optional during packaging on platforms without pre-installed toolchains

## 1.0.5 — 2026-08-28

### Highlights

- **macOS DMG packaging:** Fixed macOS release artifact generation for ARM64 and x64 DMG installers

## 1.0.4 — 2026-08-28

### Highlights

- **macOS CI pipeline:** Dedicated macOS GitHub-hosted runners for cross-compiling Darwin CLI and desktop binaries
- **Image generation controls:** Added image model tuning controls (aspect ratio, seed, inference steps, negative prompt) with inline rendering
- **Settings navigation:** Polished settings navigation hierarchy and profile dropdown dismissal behavior

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

---

## Archived Pre-v1 Private Beta (v2.0.0 – v2.1.10)

*The following milestones document the pre-public private beta architecture prior to the official v1.0.0 open-source reboot. Release assets for these early builds were superseded by v1.0.0.*

### 2.0.0 — 2026-08-02 (Private Beta)

- **Prefix cache (Phase 1):** Prefix stability tracking with system/tools/log_rewrite attribution, tiered compaction (50% soft warning, 60% snip, 80% prune), DeepSeek reasoning roundtrip and continuation.
- **Coordinator (Phase 2):** Planner/executor isolated sessions with deterministic routing policy (balanced, conservative, aggressive).
- **Fleet & scheduler (Phase 3):** Fleet tool with write-path preflight and parallel execution; background jobs with JSONL persistence and `wait` tool.
- **Delivery mode (Phase 5):** Evidence ledger, readiness gates, and `complete_step` sign-offs.
- **Observability:** Structured logging to `deyin.log` and privacy-respecting metrics in `agent-metrics.json`.

