---
name: automation_runs
description: Show recent automation runs (status, timestamps, final output) from automation-runs.json. Use when the user asks whether a scheduled run happened or what it produced.
---

# Show Automation Runs

Compatibility wrapper for the `automation_runs` native command (host
`automation_*` tools unavailable).

1. Read `automation-runs.json` from the host data dir (Windows:
   `%APPDATA%\@deyin\desktop\automation-runs.json`, Linux/macOS: the app
   userData dir). Missing file → "No runs recorded."
2. Entries live under `runs` with: `id`, `automationId`, `status`
   (queued/running/completed/failed/aborted), `startedAt`, `finishedAt`,
   `reason`, `finalText`, `events`.
3. Print the most recent runs (default 5): status, times, and a short tail of
   `finalText` (failure detail is in `reason`). Map `automationId` to names via
   `automations.json` when available.

Mention this wrapper ran in compatibility mode; the built-in tool family
appears after the app is rebuilt/restarted.
