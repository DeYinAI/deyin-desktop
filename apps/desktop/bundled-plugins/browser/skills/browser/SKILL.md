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

- Sites requiring the user's logged-in Chrome session → use the **chrome** plugin (`chrome_open`, then `chrome_snapshot`). If the `chrome_*` tools are missing or report Chrome is not connected, tell the user to turn it on in Settings → Chrome; do not try to sign in to their accounts inside this in-app browser
- OS-level desktop apps → use **computer-use**

## Workflow

1. Before navigating to a local development URL (e.g. `localhost:5173`), ensure the local dev server is running and accepting connections. Probe port readiness if uncertain (e.g. `(echo > /dev/tcp/127.0.0.1/5173) 2>/dev/null && echo OPEN || echo CLOSED`).
2. Use `browser_navigate` to open URLs (https added automatically when omitted).
3. Call `browser_snapshot` before clicking or typing. It is an accessibility outline (roles and names) with a `[ref=eN]` on each interactive element; pass that `ref` to the action tools. Refs are cleared by navigation: snapshot again after the page changes. A `selector` is accepted as a fallback and is resolved to a ref for you.
4. Prefer `browser_fill` for form fields (it replaces the value); use `browser_click` / `browser_hover` with `ref`. Input is real mouse and keyboard events, so it behaves like a user.
5. If an action opens a JavaScript alert, confirm or prompt, the page is blocked until you call `browser_handle_dialog`.
6. Use `browser_tabs` to list, open, switch, or close tabs when multiple pages are open.

## Rules

- Do not use shell `open` / `xdg-open` when the user asked for browser automation.
- Never navigate to a localhost port before verifying the server is up — avoid `ERR_CONNECTION_REFUSED`.
- Tail `browser_console` / `browser_network` with a small line count — logs can be large.
- Typing or pressing keys moves keyboard focus into the browser panel; that is expected while you work there.
