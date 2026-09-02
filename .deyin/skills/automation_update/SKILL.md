---
name: automation_update
description: Change an existing automation (rename, new prompt, new cron, workspace, model, enable/disable) by editing the stored JSON. Use when the user asks to reschedule or modify a saved automation.
---

# Update an Automation

Compatibility wrapper for the `automation_update` native command (host
`automation_*` tools unavailable).

1. Read `automations.json` from the host data dir (Windows:
   `%APPDATA%\@deyin\desktop\automations.json`, Linux/macOS: the app userData
   dir). Locate the automation by id, or by name if no id was given. Abort with
   a clear message if not found.
2. Apply only the requested fields: `name`, `description`, `payload.prompt`,
   `trigger` (`{"kind":"cron","expression"}` or `{"kind":"manual"}`),
   `target.workspacePath`, `target` + `distro` for wsl, `model`, `enabled`.
   Validate cron shape (5 fields). **Always set `lastScheduledAt` to now when
   changing a cron expression** so scheduler catch-up cannot fire the old
   schedule's missed slot on next launch.
3. Bump `updatedAt` to now; keep every other automation byte-identical; write
   the file back.

The change takes effect on next app launch (scheduler state is in-memory).
Prefer the Automations UI when the app is running — it re-arms the scheduler
instantly. Say which mode you used.
