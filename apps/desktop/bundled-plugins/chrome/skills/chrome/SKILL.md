---
name: chrome
description: Automate the user's real Chrome browser when auth cookies or logged-in sessions are required. Prefer purpose-built APIs first; fall back to chrome_* tools only when needed.
---

# Chrome automation

## When to use

- Sites requiring the user's Google/work SSO session
- Shopping, email, or SaaS dashboards already logged in Chrome
- When in-app browser has no cookies for the target site

## When not to use

- `localhost` / local dev → use **browser** plugin
- OS desktop apps → use **computer-use**

## Consent

First attach requires user approval. New origins may prompt again.

## Tools

Mirror browser tools with `chrome_` prefix: `chrome_navigate`, `chrome_click`, `chrome_snapshot`, etc.
