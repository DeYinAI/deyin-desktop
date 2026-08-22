---
name: computer-use
description: Initialize OS desktop automation on Windows. Use computer_* tools to list apps/windows, capture state, and interact with allowed applications.
---

# Computer use (Windows)

## Before you start

1. Confirm computer use is enabled in Settings → Computer Use.
2. Call `computer_list_apps` or `computer_list_windows` to find the target.
3. Call `computer_get_state` with a window id to get a screenshot and accessibility tree.

## Interaction pattern

1. **Observe** — `computer_get_state` returns screenshot path + element refs.
2. **Act** — `computer_click`, `computer_type`, `computer_press_key`, `computer_scroll` using refs from the latest state.
3. **Re-observe** after each action when the UI may have changed.

## Safety

- Only interact with apps on the user's allowlist.
- High-risk actions (purchases, sends, deletes) require user confirmation.
- User can press **Esc** to cancel in-flight action chains.

## Non-Windows

On Linux/macOS this plugin is disabled; use browser or chrome plugins for web tasks.
