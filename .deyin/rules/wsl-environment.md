# Deyin Desktop — WSL Environment Rules (learned by exercising every tool surface)

## Shell / toolchain
- ALWAYS prepend the nvm toolchain in the first bash call of a session: `export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"`. The system pnpm is a broken Windows shim (`/mnt/c/.../npm/pnpm` under Node v12.22.9 → `SyntaxError: Unexpected token '.'`). Sourcing `nvm.sh` does not persist into background shells; the PATH prepend does.
- The shell is WSL bash for this `\\wsl.localhost` workspace — never write PowerShell syntax, never chain with `;` when ordering matters.
- `rg`, `make`, `yarn` are NOT installed. Prefer the dedicated `glob`/`grep`/`ls` tools over `find`/`rg`.

## Dev server + browser
- Before ANY `browser_navigate` to a localhost URL, start or probe the dev server first: `pnpm --filter @deyin/web dev --port 5173 --strictPort` as a background task, verify with `(echo > /dev/tcp/127.0.0.1/5173) 2>/dev/null && echo OPEN || echo CLOSED`.
- Never navigate before the port is OPEN — `ERR_CONNECTION_REFUSED` wastes a round trip.

## Automations
- After `automation_run`, always verify side effects on disk; run output summaries can be wrong (a run once claimed a file was written that never existed).
- Manual automations: `automation_create` with empty `cron` + `enable:false`; trigger with `automation_run`.

## UI automation
- Use the browser tool for Deyin in-app pages (its UIA tree is nested anonymous panes — computer use cannot click inside). Reserve computer use for native windows (Chrome, Notepad, Discord).
- Computer-use element refs are scoped per window handle.

## Verification habits
- Batch independent read-only probes in one turn (env_info + automation_list + computer_list_windows).
- Verify build/run claims with the filesystem or process list, not by trusting self-reported tool output.
