---
name: automation_create
description: Create a scheduled automation (cron or manual) that runs an agent prompt in a workspace. Persists immediately and arms the scheduler. Use when the user asks to automate or schedule a recurring task.
---

# Create an Automation

You are acting as the `automation_create` native command (host `automation_*`
tools unavailable — e.g. older build or web host). Fulfil the request, then tell
the user this wrapper ran in compatibility mode and the built-in tool family
appears after they rebuild/restart the desktop app.

## Inputs

- name (required): short display name
- prompt (required): the prompt the agent runs on every execution
- cron (optional): 5-field expression, e.g. `0 8 * * *` = daily 08:00; omit for manual
- workspacePath (required): absolute path the agent runs in
- targetKind (optional): `local` (default) or `wsl` (+ distro, e.g. Ubuntu-22.04)
- model (optional): defaults to the app default model; provider defaults to openference

## Implementation

Edit `automations.json` in the host data dir (Windows:
`%APPDATA%\@deyin\desktop\automations.json`, Linux/macOS:
`~/.deyin/desktop/automations.json` or the app's userData dir — check which
exists). Read it first; keep every existing automation untouched.

Schema: `{"automations": [{ "name", "description", "enabled": true, "payload":
{"kind": "prompt", "prompt"}, "trigger": {"kind": "cron", "expression"} |
{"kind": "manual"}, "target": {"kind": "local", "workspacePath"} | {"kind":
"wsl", "distro", "workspacePath"}, "model", "providerId", "lastScheduledAt",
"id": <uuid v4>, "createdAt": <epoch ms>, "updatedAt": <epoch ms> }]}`. Generate
a fresh uuid for `id`; set `createdAt`/`updatedAt` to now. **Always set
`lastScheduledAt` to now when adding a cron automation** — the scheduler
catch-up would otherwise fire the most recent missed slot on next launch.

The change takes effect the next time the app starts (scheduler state is
in-memory; the file is read once at launch). Say so in your reply. Prefer the
Automations UI (New automation) when possible — it arms the scheduler instantly.
