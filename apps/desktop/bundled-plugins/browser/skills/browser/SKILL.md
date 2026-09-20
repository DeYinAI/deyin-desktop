---
name: browser
description: Route browser automation to Deyin's in-app workspace browser. Use for localhost, 127.0.0.1, ::1, and file:// URLs; after frontend changes open the relevant local URL; never substitute shell open for explicit browser tool requests.
---

# Browser automation

## When to use

- Local development URLs: `localhost`, `127.0.0.1`, `::1`, `file://`
- Pages inside the workspace browser tab (no external Chrome needed)
- After editing frontend code, navigate to the relevant local URL to verify

## When not to use

- Sites requiring the user's logged-in Chrome session → use the **chrome** plugin
- OS-level desktop apps → use **computer-use**

## Workflow

1. Before navigating to a local development URL (e.g. `localhost:5173`), ensure the local dev server is running and accepting connections. Probe port readiness if uncertain (e.g. `(echo > /dev/tcp/127.0.0.1/5173) 2>/dev/null && echo OPEN || echo CLOSED`).
2. Use `browser_navigate` to open URLs (https added automatically when omitted).
3. Call `browser_snapshot` before clicking or typing to get element `ref` ids and selectors.
4. Prefer `browser_fill` for form fields; use `browser_click` with `ref` or `selector`.
5. Use `browser_tabs` to list, open, switch, or close tabs when multiple pages are open.

## Rules

- Do not use shell `open` / `xdg-open` when the user asked for browser automation.
- Never navigate to a localhost port before verifying the server is up — avoid `ERR_CONNECTION_REFUSED`.
- Tail `browser_console` / `browser_network` with a small line count — logs can be large.
