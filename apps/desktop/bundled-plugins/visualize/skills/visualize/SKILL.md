---
name: visualize
description: Create interactive inline visualizations in chat. Use HTML fragments (not full documents), Mermaid for simple diagrams, 2MB cap per artifact.
---

# Visualize

## When to visualize vs edit files

- **Visualize**: exploratory charts, maps, one-off diagrams for the conversation
- **Edit project files**: durable assets committed to the repo

## HTML fragments

Write to `<userData>/visualizations/<thread-id>/<name>.html` — body content only, no `<html>` wrapper.

Embed in your reply:

```
::deyin-inline-vis{file="chart.html" title="Sales by region"}
```

## Mermaid

For simple flowcharts/sequence diagrams, prefer Mermaid in markdown when interactivity is not needed.

## Limits

- Max 2MB per HTML fragment
- Sandboxed iframe: scripts allowed, network restricted by CSP
