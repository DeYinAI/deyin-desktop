---
name: automation_run
description: Trigger a saved automation immediately and report the result. Use when the user wants to test an automation now ("run it once") rather than waiting for the schedule.
---

# Run an Automation Now

Compatibility wrapper for the `automation_run` native command (host
`automation_*` tools unavailable).

1. Find the automation id by reading `automations.json` in the host data dir
   (Windows: `%APPDATA%\@deyin\desktop\automations.json`, Linux/macOS: the app
   userData dir); match by name if the user didn't give an id.
2. Preferred path: ask the user to press **Run now** in Automations (it executes
   live, needs Openference sign-in) — or, if the desktop app is running with
   remote debugging enabled, prefer the `automation_run` tool instead.
3. Fallback (app closed): a run started from the file alone will not execute,
   because the scheduler only exists inside the running app. In that case say
   so plainly, and offer to launch the app so the schedule (or the Run now
   button) takes over.
4. After a run completes, results land in `automation-runs.json` (same dir) —
   see the automation_runs wrapper to read them. The digest prompt writes
   `daily-news.md` into the automation's workspace.

Report honestly whether the run executed or only the request was staged.
