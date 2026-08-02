---
name: threat-model
description: Produce a lightweight threat model for a feature or repo area — assets, trust boundaries, and top risks.
---

# Threat model

1. Identify assets (data, credentials, user accounts) and trust boundaries.
2. List entry points (HTTP routes, IPC, MCP tools, git hooks, automations).
3. Brainstorm STRIDE-style threats for each boundary.
4. Map threats to existing controls and gaps; prioritize with `security_triage_finding` where applicable.
5. Summarize top 3 risks and recommended mitigations.
