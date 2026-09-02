---
name: automation_delete
description: Permanently delete a saved automation by removing it from the stored JSON. Use when the user asks to remove or stop a scheduled automation for good.
---

# Delete an Automation

Compatibility wrapper for the `automation_delete` native command (host
`automation_*` tools unavailable).

1. Read `automations.json` from the host data dir (Windows:
   `%APPDATA%\@deyin\desktop\automations.json`, Linux/macOS: the app userData
   dir). Locate the automation by id, or by name if no id was given. Abort with
   a clear message if not found.
2. Remove exactly that entry; keep every other automation untouched; write the
   file back.
3. Note: its run history stays in `automation-runs.json` — offer to leave it
   (audit trail) unless the user wants it gone too.

Deletion takes effect on next app launch while the app keeps running (the
in-memory scheduler still holds the old job until restart; toggling it off in
the Automations UI is the instant way). If the user only wants to pause it,
prefer `enabled: false` via the automation_update wrapper or the UI toggle.
