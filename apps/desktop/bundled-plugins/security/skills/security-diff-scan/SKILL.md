---
name: security-diff-scan
description: Scan a git diff or PR changes for security issues before merge.
---

# Security diff scan

1. Obtain the diff (`git diff` or review tab content).
2. Call `security_scan_diff` with the unified diff text.
3. Triage each finding with `security_triage_finding`.
4. Link findings to file:line when available.
