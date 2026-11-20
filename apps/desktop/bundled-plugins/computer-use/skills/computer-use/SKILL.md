---
name: computer-use
description: Drive Windows desktop apps with computer_* tools. Use for native apps (Notepad, Explorer, Office, settings dialogs) and anything that is not a web page; for web pages prefer the chrome or browser tools.
---

# Computer use (Windows)

You control apps through their accessibility tree, with a screenshot for context. Quiet methods run first, so the user can keep working while you do; the real mouse and keyboard are used only when nothing quieter works.

## Pick the right tool for the job

- **A web page in the user's Chrome** → `chrome_*` tools. They work in background tabs and do not touch the user's screen.
- **A page in Deyin's built-in browser** → `browser_*` tools.
- **Anything else on the desktop** → `computer_*` (this skill).

## Before you start

1. `computer_list_windows` to find the target (or `computer_launch_app`, which returns the window it opened).
2. `computer_get_state` with the window id: window position, a screenshot file, and an outline of the elements with **refs**.

## The loop

1. **Observe**: `computer_get_state`. Use `query` to find an element by its text without reading the whole tree, and `depth` / `max_nodes` to read less.
2. **Act** on a **ref** from that observation: `computer_click`, `computer_type`, `computer_set_value`, `computer_press_key`, `computer_scroll`, `computer_drag`, `computer_hover`.
3. **Re-observe** after any action that may have changed the UI. A ref from an older observation is rejected ("re-observe") instead of clicking the wrong thing; that is expected, not a bug.
4. After opening something slow, `computer_wait` with `window_id` and `text` waits for an element to appear instead of guessing a delay.

## How actions are performed (the method ladder)

Every action result says which method did the work:

| method | what it is | touches the user's mouse/focus? |
| --- | --- | --- |
| `msg` | window messages to classic Win32 controls (buttons, edit boxes, lists) | no |
| `uia` | UI Automation patterns (invoke, toggle, select, expand, scroll, value) | no, or briefly and restored |
| `input` | the real mouse and keyboard | yes; the pointer and the previous foreground window are put back afterwards |

The default `method: "auto"` tries them in that order. Set `method` to `uia` or `msg` to forbid the real mouse (the call then fails instead of falling back), or to `input` for custom-drawn UIs that expose nothing.

`computer_press_key`, `computer_hover` and `computer_drag` always use the real input, because there is nothing quieter that does the same.

## Coordinates

- A **ref** is the best target. Use `x`/`y` only when the element has no ref.
- `x`/`y` are **pixels in the screenshot, measured from the window's top-left corner**. Every `computer_get_state` states the screenshot size and scale. Large windows are downscaled; the host converts back for you.
- `computer_list_displays` lists the monitors; screen coordinates span all of them.

## Keys and chords

`computer_press_key` takes a key or a chord joined with `+`: `enter`, `tab`, `escape`, `f5`, `ctrl+a`, `ctrl+shift+t`, `alt+left`. It brings the window forward briefly. For typing text use `computer_type`; it does not press Enter.

## Other tips

- A modal dialog is its own window. If `computer_get_state` says the elements are unavailable because the app is inside a dialog, call `computer_list_windows`, find the dialog, and observe that.
- Right-click (`button: "right"`), double-click (`count: 2`) and ctrl/shift-click (`modifiers`) are on `computer_click`.
- `computer_set_value` replaces a field's contents without typing; prefer it to select-all plus type.
- Apps running **as administrator** cannot be driven; the window listing says so.

## Safety

- Only apps on the user's allowlist are driven; the first use of an app asks.
- Closing windows (`alt+f4`, `ctrl+w`), clearing data, anything with the Windows key, right clicks, and anything that purchases, sends, deletes or signs in needs the user's confirmation. Do not try to work around a refusal.
- **Stop**: the user can press the Stop button on screen or `Ctrl+Alt+Shift+Esc` at any time. When you see "stopped by the user", stop and ask how they want to continue; do not retry on your own.
- **Takeover**: if the user moves the mouse or types while you are using the real input, the action is abandoned and computer use pauses until they resume. After a takeover, call `computer_get_state` before doing anything else; the screen has probably changed.

## Non-Windows

On Linux/macOS this plugin is disabled; use the chrome or browser plugins for web tasks.
