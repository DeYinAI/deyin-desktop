---
name: automation_list
description: List saved automations with their schedule, target, model and enabled state. Use when the user asks what automations exist or what is scheduled.
---

# List Automations

Compatibility wrapper for the `automation_list` native command (host
`automation_*` tools unavailable).

1. Read `automations.json` from the host data dir (Windows:
   `%APPDATA%\@deyin\desktop\automations.json`, Linux/macOS: the app userData
   dir / `~/.deyin/desktop`). Create a folder does not exist → report that no
   automations are saved.
2. For each entry print: name — trigger (cron expression or manual), target
   (kind + workspacePath), enabled, model, updatedAt, lastScheduledAt, id.

If the file is missing, say "No automations saved." Mention this wrapper ran in
compatibility mode; after the app is rebuilt/restarted the `automation_list`
tool shows live state including run history.
