# Toolchain Exercise — Error Log & Optimization Report

Date: 2026-09-20 · Scope: every Deyin desktop tool surface exercised in one session, with real errors captured verbatim.

## 1. What was exercised (all green unless noted)

| Surface | Calls used | Result |
|---|---|---|
| Shell (WSL bash) | `env_info`, `bash`, background tasks | ✅ works; 2 environment traps found (below) |
| Plugins / MCP | `mcp__cloudflare-docs__search_cloudflare_documentation`, `mcp__deyin-security__security_scan_repo` | ✅ both returned data (doc chunks, 541 files scanned) |
| Automation loop | `automation_create` → `automation_run` → `automation_runs` | ✅ run `c72b14fa` completed in ~21 s |
| Browser plugin | `browser_navigate` → `browser_snapshot` → `browser_console` → `browser_screenshot` | ✅ after starting Vite manually |
| Computer use | `computer_list_windows`, `computer_get_state` (window 132438 "Deyin") | ✅ screenshot + window bounds; a11y tree shallow |
| Skills | consulted `automation-*` / `browser` SKILL.md guidance | ✅ matched tool behavior |
| Todo tracking | `todo_write` multi-step list | ✅ |

## 2. Errors captured (verbatim) and root causes

### E1 — Automation subagent: `spawn powershell.exe ENOENT`
- Surface: automation run `c72b14fa-9002-42fb-8c2f-8b6f0110bae8` (first shell call inside the run).
- Cause: the run's workspace was a `\\wsl.localhost\...` UNC path, but the spawned host process invoked `powershell.exe` which is not on that execution context's PATH.
- Status: **already fixed upstream** — Deyin v1.0.26 changelog ("Unified Shell Execution… dynamically routing to WSL2 bash only for `\\wsl$` UNC paths"). This session's run recovered and completed.

### E2 — False-positive automation output: file claimed written, file absent
- `automation_run` final output said `probe-output.md` was written to the workspace root (261 bytes), but the file does not exist anywhere findable (`find` maxdepth 2 over workspace + `$HOME` → nothing).
- Lesson: **never trust the run's self-reported summary; verify side effects on disk.** Log this as a verification rule.

### E3 — `ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/`
- Cause: no dev server was running when the browser tool navigated. Browser tooling is only as good as the local servers it points at.
- Fix applied: started `pnpm --filter @deyin/web dev --port 5173 --strictPort` as a background task, then navigated successfully.

### E4 — WSL: pnpm resolves to the Windows install → `SyntaxError: Unexpected token '.'`
```
/mnt/c/Users/Anh/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs:18
 if(!require('module')?.enableCompileCache?.())
SyntaxError: Unexpected token '.'
```
- Cause: inside WSL, `pnpm` on PATH is the Windows shim (`/mnt/c/.../npm/pnpm`) run under Ubuntu's system Node **v12.22.9**, which cannot parse optional chaining.
- Fix that worked: prepend the nvm Node to PATH — `export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"` (Node v24.12.0 + pnpm 10.33.0). Sourcing `nvm.sh` in the background-shell invocation did **not** stick; absolute PATH prepend did.

### E5 — Missing utilities in WSL
- `rg`, `make`, `yarn` not installed; first `find` probe returned exit 2 due to shell quoting/semantics. Prefer the dedicated `glob`/`grep` tools over raw `find`/`rg` in this environment.

## 3. Optimizations for the LLM (stop wasting requests)

1. **Prepend the nvm PATH in the FIRST shell call** when working in this WSL workspace — avoids the E4 crash-retry cycle (saves 2–3 round trips).
   `export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"`
2. **Start/verify the dev server before any browser navigation.** Probe the port in the same call:
   `(echo > /dev/tcp/127.0.0.1/5173) 2>/dev/null && echo OPEN || echo CLOSED`
3. **Batch independent probes** (env_info + automation_list + computer_list_windows went out in one turn) instead of one-tool-per-turn.
4. **Verify automation side effects on disk** (`ls`/`cat` the file) rather than trusting the run output text (E2).
5. **For in-app UI content use the browser tool, not computer use** — the Deyin window's UIA tree is just nested anonymous panes; the browser snapshot gives clickable refs instantly. Reserve computer_use for native windows (Chrome, Notepad, Discord).
6. **Quote defensively in WSL bash**: `&&` chains, avoid `head` after pipes to bounded tools, prefer `glob`/`grep` tools over `find` (no `rg` installed).
7. **Security scan noise**: `security_scan_repo` flags `dist/`, `out/` build artifacts and test fixtures — review only `src/` hits; the `sql-concat` hits in `browser-control.ts` are string-template builders, not SQL.
