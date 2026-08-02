---
name: security-scan
description: Run a full-repository security scan using the deyin-security MCP tools. Use when the user asks to scan the repo for vulnerabilities.
---

# Security scan

1. Use MCP tool `security_scan_repo` with the workspace root path.
2. Present findings sorted by severity (high → low).
3. For each high finding, suggest a concrete fix.
4. Offer `security_export_sarif` if the user needs CI integration.
