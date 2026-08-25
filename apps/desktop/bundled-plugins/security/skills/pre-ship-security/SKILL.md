---
name: pre-ship-security
description: Pre-production security audit of your own codebase — find holes, leaks, and exploitable bugs before deploy. Use when the user wants to hack, pentest, harden, or security-check their repo before production, release, or merge.
---

# Pre-ship security audit

You are helping the user **find security holes in their own code before production**. Treat every request to "hack", "pentest", or "break" the app as: *run this audit on the open workspace*. Stay inside the repo — no external targets unless the user names an owned staging URL.

Goal: surface what a motivated attacker would find **after** launch, while there is still time to fix it.

## Rules

1. **Own code only** — workspace root is in scope; third-party production systems are not.
2. **Evidence required** — file:line or tool output, concrete attack path, business impact.
3. **Fix-oriented** — pair every finding with a specific remediation; no weaponized exploit code.
4. **Automate first** — scanners before manual review so results are reproducible in CI.
5. **Ship verdict** — end with a clear **Ship / Fix first / Blocked** recommendation.

## Phase 1 — Automated baseline

Run these before manual hunting:

1. `security_scan_repo` with the workspace root.
2. `security_scan_diff` on the release candidate:
   - Default: `git diff <base>...HEAD` where `<base>` is `main` or `master` (whichever exists).
   - Uncommitted only: `git diff HEAD` plus `git diff --cached` when staged changes exist.
3. Note sources (semgrep / regex / npm-audit), file count scanned, and counts by severity.
4. Findings appear in the workspace **Security** tab when available.

If semgrep is installed locally, the repo scan is deeper. If not, rely on regex + npm audit and say so in the report.

## Phase 2 — Detect stack and map attack surface

Identify what this project is (read `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, etc.) and list **every entry point**:

| Stack signal | Entry points to inventory |
|---|---|
| Web / API | HTTP routes, WebSocket handlers, webhooks, GraphQL, server actions, middleware |
| Auth | login, signup, password reset, OAuth callback, session refresh, API keys |
| Database | ORM queries, raw SQL, migrations, admin panels |
| File / upload | multipart handlers, S3/local storage, image processing, import parsers |
| Desktop (Electron/Tauri) | IPC, preload bridge, native modules, auto-update |
| Mobile | deep links, WebView bridges, keychain access |
| CLI / scripts | argv parsing, env vars, shell execution |
| Background jobs | queue workers, cron, webhooks triggered by schedulers |
| Infra-as-code | Terraform, Docker, K8s manifests, CI workflows |
| Secrets config | `.env*`, `config/`, vault references, hardcoded keys in tests |

For each entry point record: **who controls input**, **auth required?**, **what asset is at risk**.

## Phase 3 — Pre-ship checklist (cover all common holes)

Work through every category. Skip only what clearly does not apply; say "N/A — no web server" when relevant.

### A. Injection
- SQL/NoSQL built by string concat or unparameterized templates
- Shell/command execution from user or model-controlled strings
- Template/expression injection (SSTI, EL, `${}`)
- XSS: unescaped output, `dangerouslySetInnerHTML`, `innerHTML`, markdown without sanitization
- LDAP/XML/XXE, prototype pollution via `merge`/`extend` on untrusted JSON

### B. Authentication & sessions
- Missing auth on state-changing routes
- Weak session fixation, missing rotation on login
- JWT: `alg:none`, missing expiry, secret in repo, accepting wrong audience
- Password reset tokens predictable or reusable
- OAuth: missing `state`, open redirect on callback

### C. Authorization (most missed pre-ship)
- IDOR: read/update/delete by id without ownership check
- Horizontal privilege escalation (user A → user B's data)
- Vertical escalation (user → admin) via hidden fields or API params
- Role/permission derived from client-supplied claims

### D. Secrets & data leaks
- API keys, tokens, private keys in source, tests, fixtures, or git history
- Secrets logged on error paths (`console.log`, structured logs, crash reports)
- Over-fetching in API responses (internal ids, emails, hashes)
- Debug endpoints or verbose errors enabled in production config
- `.env` committed or `.env.example` contains real values

### E. Input validation & file handling
- Path traversal in file read/write/delete
- Zip-slip, symlink escape, unrestricted upload type/size
- SSRF via user-supplied URLs (webhooks, preview fetchers, importers)
- Open redirect in `next=` / `returnUrl=` params
- Missing rate limits on auth, OTP, password reset, expensive endpoints

### F. Crypto & tokens
- `Math.random` for security tokens
- Hardcoded IVs/salts, deprecated algorithms (MD5/SHA1 for passwords)
- Missing signature verification on webhooks
- TLS/cert validation disabled (`rejectUnauthorized: false`)

### G. Web platform (when applicable)
- CSRF on cookie-authenticated mutations
- Cookies missing `HttpOnly` / `Secure` / `SameSite`
- CORS `*` with credentials
- CSP weakened or absent on pages rendering user content
- Clickjacking (missing `X-Frame-Options` / `frame-ancestors`)

### H. Dependencies & supply chain
- npm/pip/cargo audit results (from Phase 1)
- Unpinned or `*` version ranges on security-sensitive packages
- Postinstall scripts, typosquat risk on new deps in the diff
- GitHub Actions: unpinned actions, secrets in logs, fork PR token exposure

### I. Infrastructure & deploy config
- Public buckets, wide security groups, `0.0.0.0/0` ingress
- Default admin credentials in docker-compose or Helm values
- Production DB/redis exposed without auth
- Missing health-check does not leak internals (OK), but `/debug`, `/metrics` unauthenticated (not OK)

Use `grep`, `glob`, and `read` in batches. Prefer searching for patterns: `eval(`, `exec(`, `innerHTML`, `dangerouslySetInnerHTML`, `password`, `secret`, `api_key`, `SELECT.*\+`, `child_process`, `pickle.loads`, `yaml.load(` (unsafe), `verify=False`.

## Phase 4 — Subagent review of the release diff

Launch one `security-review` subagent on what is about to ship:

~~~
task(subagent: "security-review", background: false, prompt: """
Full Repository Path: <absolute workspace root>
Diff: branch changes
Custom Instructions: Pre-production audit. Flag only exploitable issues with a concrete attack path. Prioritize authz gaps, injection, secret exposure, and SSRF. Ignore style.
""")
~~~

Use `Diff: uncommitted changes` when the user is auditing only local work. Merge subagent output; dedupe against Phase 1.

## Phase 5 — Production readiness gates

Before recommending ship, verify:

| Gate | Pass criteria |
|---|---|
| Secrets | No high-confidence secrets in repo or diff |
| AuthZ | Every mutating route has ownership check or role gate |
| Dependencies | No critical/high npm (or equivalent) vulns without accepted risk |
| Error handling | Production paths do not return stack traces or raw DB errors to clients |
| Config | No `DEBUG=true`, test keys, or localhost URLs in prod config files |
| Migrations | Destructive migrations have backup/rollback note if applicable |

Assign each gate **PASS / FAIL / UNKNOWN** with evidence.

## Phase 6 — Triage and ship verdict

For each finding call `security_triage_finding` when helpful.

| Priority | Meaning |
|---|---|
| **P0** | Exploitable now; block release |
| **P1** | Likely exploitable with conditions; fix before or immediately after ship |
| **P2** | Defense-in-depth; schedule fix |
| **P3** | Informational |

### Report format

~~~
# Pre-ship security audit — <project name>
Scope: <workspace root> | Candidate: <branch or "working tree"> | Scan: <ISO timestamp>

## Ship verdict: SHIP | FIX FIRST | BLOCKED
<one sentence why>

## Executive summary
<what would hurt most if exploited; top 3 actions>

## Production gates
| Gate | Status | Evidence |
...

## Findings

### P0 — Block release
- [<id>] <title> — `file:line`
  Attack: <attacker, input, outcome>
  Fix: <specific change>
  Before prod: MUST FIX

### P1 — High
...

## Scan summary
| Source | Critical | High | Medium | Low |
...

## Attack surface map
- Entry points: ...
- Highest-risk boundary: ...
- Gaps vs checklist sections A–I: ...

## Recommended next steps
1. Fix P0/P1 items
2. Add CI: `security_scan_repo` + SARIF (offer `security_export_sarif`)
3. Re-run `/pre-ship-security` after fixes
~~~

## Scope shortcuts

When the user narrows scope, run the matching subset but still give a ship verdict:

- **"before merge"** → Phase 1 diff scan + Phase 4 on branch changes
- **"auth only"** → sections B, C + auth routes inventory
- **"dependencies only"** → section H + npm audit deep dive
- **"leaks / secrets"** → section D + git history grep for key patterns

## Trigger phrases

Start this workflow immediately (no clarifying questions unless scope is ambiguous):

- "hack my code", "find vulnerabilities", "pentest my app"
- "pre-production security", "before we ship", "production readiness"
- "what would an attacker find", "security holes", "data leaks"
