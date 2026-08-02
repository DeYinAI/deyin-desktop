---
name: triage-finding
description: Triage a security finding — assign priority, owner, and remediation steps using deyin-security MCP tools.
---

# Triage finding

1. Collect finding details (ruleId, severity, message, file:line).
2. Call `security_triage_finding` with the severity and rule id.
3. Recommend a fix or mitigation with concrete code changes.
4. If the finding is false positive, document why and suggest a rule exception.
