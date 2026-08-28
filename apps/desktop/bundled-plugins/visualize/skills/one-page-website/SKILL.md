---
name: one-page-website
description: Create self-contained one-page websites as preview artifacts when the user asks for a landing page, portfolio, microsite, or similar.
---

# One-page website

When the user asks to **create a one-page website**, **landing page**, **portfolio page**, **microsite**, or similar:

1. Design a complete, polished page with inline CSS (and inline JS only when needed).
2. Call **`create_page`** with a short `title`, the full `html`, and an optional `file` name.
3. Tell the user the page is in the **Preview** panel and they can click the card to reopen it.

## When to use create_page vs write

- **`create_page`**: conversational one-off pages the user wants to *see* immediately (artifacts, not repo files).
- **`write`**: durable HTML the user will edit, deploy, or commit in the workspace.

## HTML guidance

- Prefer a single self-contained document: `<style>` in `<head>`, minimal external dependencies.
- Make it responsive (`viewport` meta, fluid layout).
- Use semantic HTML and accessible contrast.
- Do **not** use `visualize_write` for full websites — that tool is for small chart/diagram fragments in chat.

## After creation

Confirm the Preview panel opened. Offer tweaks (colors, copy, sections) and call `create_page` again with an updated file name or the same name to replace the artifact.
