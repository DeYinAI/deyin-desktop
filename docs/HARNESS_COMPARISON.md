# Agent Harness Comparison — Deyin vs. the V2 reference harness

Reverse-engineered from the reference implementation's source (`packages/core/src/session/runner/llm.ts`,
`packages/schema/src/session-event.ts`, `packages/core/src/session/message-updater.ts`,
`packages/session-ui/src/components/message-part.tsx`, `packages/core/src/config/mcp.ts`,
`packages/core/src/plugin/module.ts`, `packages/gui-plugins/README.md`) and its public docs.

Scope: **how the agent loop runs, what skills exist and how they load, how streaming is shaped and
rendered, and which side is more efficient.** Every claim below was read from source or docs, not inferred
from marketing pages.

---

## 1. Agent loop

### Reference (V2 runner)

Two nested loops in `session/runner/llm.ts`:

```
while (shouldRun)            // outer: input queue
  while (needsContinuation)  // inner: one model turn per iteration
    result = runTurn(sessionID, promotion, step)
    step += 1
    needsContinuation = result.needsContinuation || hasPending(stage="steer")
  shouldRun = hasPending(stage="queue")
```

- **Inputs are first-class**: two stages, `steer` (injected mid-run) and `queue` (next turn). A promoted
  input resets the inner step counter. The runner owns tool execution itself, in-process.
- **Final step**: tool materialization is skipped and `toolChoice: "none"` is set — the guarantee is
  enforced by the request shape, not by prose.
- **The cutoff notice is a `user` message.** The reference shipped this as a bug fix: an `assistant`-role
  trailing notice is a prefill, so the model emits a stop token and the turn ends empty (and 400s on
  Claude with thinking on).
- **Step limit** resolves from `agent.steps`, not a hardcoded constant.

### Deyin (`packages/agent-core/src/loop.ts`)

Single `for (let step = 1; step <= maxSteps; step++)` loop that owns the turn, the tool calls, and the
post-turn nudges.

| Concern | Reference | Deyin |
| --- | --- | --- |
| Steering input | promoted by the outer loop | `drainPendingMessages` at the top of each step |
| Queue input | outer loop after inner finishes | host-side queue in `app.tsx`, drained by send-now |
| Final-step guarantee | tools stripped + `toolChoice: none` | user-role warning on `step === maxSteps` |
| Step limit source | `agent.steps ?? 25` | `normalizeMaxSteps()` — `null`/`0` = unlimited |
| Stall / no-tool recovery | not in the runner | `diagnoseTurnEnd` + `STALL_NUDGE_STREAK_LIMIT` |
| Truncation recovery | — | `continuationNudges` + `LENGTH_RECOVERY_LIMIT` |
| Goal review loop | — | reviewer round budget (`goal-reviewer.ts`) |
| Compaction | separate service | inline `maybeCompact("pressure")` with prune → fold |

**Verdict.** The reference loop is cleaner about *input* (two explicit stages, promotion semantics). Deyin's
loop is richer about *recovery* (stalls, truncation, goal review, compaction in one place). Neither is
strictly better; the reference's `toolChoice: "none"` final step is strictly safer than a prose warning and
Deyin should adopt it.

---

## 2. Skills

### Reference

- Discovery roots: `~/.config/<app>/skills`, `.opencode/skills`, plus **compatibility roots**
  `~/.claude/skills` and `~/agents/skills`, project-scoped, walking upward from cwd.
- Two shapes: root-level `*.md`, and nested `*/SKILL.md` (a directory with `SKILL.md` is one skill; search
  stops inside it). Six directory levels deep.
- **Only name + description + id are advertised** each step. The body is loaded by a `skill` tool call and
  injected as a user turn.
- **HTTP catalogs**: `skills: ["https://host/catalog/"]` fetches `index.json`, lists entries, and downloads
  a skill's files only when that skill is loaded. Version is a content hash.
- Per-skill permission patterns (`allow` / `deny` / `ask`), per-agent overrides, and an
  `autoinvoke: false` opt-out from the model-facing list.
- `/skill-id` explicit prompt invocation.

### Deyin

- Discovery roots: workspace → user → plugin → built-in, recursive to `MAX_DEPTH = 4`, first name wins.
- Frontmatter: `name`, `description`, `disable-model-invocation`.
- `skillsPromptSection()` advertises `name: description (path)` and tells the model to `read` the file.

| Capability | Reference | Deyin |
| --- | --- | --- |
| Nested `SKILL.md` | ✅ | ✅ |
| Name/description-only advert | ✅ | ✅ |
| Body loaded on demand | via `skill` tool | via `read` on the advertised path |
| Compatibility roots (`.claude/`, `.agents/`) | ✅ | ❌ |
| HTTP skill catalogs | ✅ | ❌ |
| Per-skill permission patterns | ✅ | ❌ |
| Explicit `/skill` load | ✅ | ✅ (commands) |
| Built-in shipped skills | shell features are plugins | ✅ bundled plugins |

**Verdict.** Deyin has the loading model but not the distribution model. HTTP catalogs are the single
highest-leverage missing piece: they turn a fixed skill set into an installable one without a release.

---

## 3. MCP

### Reference (`config/mcp.ts`)

```ts
Local  { type:"local",  command: string[], cwd?, environment?, disabled?, timeout?{startup,request} }
Remote { type:"remote", url, headers?, oauth?: OAuth | false, disabled?, timeout?, protocol? }
```

- `disabled` (not `enabled`) — absent means on.
- **`codemode` defaults to `true`**: large tool catalogs are exposed as executable definitions instead of
  inflating every request's schema block.
- `pool` shares one connection across directories.
- `protocol`: `legacy | auto | 2026-07-28`.

### Deyin

Local + remote transports, catalog, per-module installs under `~/.deyin/mcp-modules/`, native OAuth with
revocation, workspace-over-user merge with trust gating, health test with tool counts.

**Deyin is ahead on** lifecycle (module install/uninstall, OAuth revoke, pooled client reset on auth change,
catalog) and **behind on** request economy: there is no Code Mode, so a large MCP catalog is paid for in
tool-schema tokens on every step.

---

## 4. Streaming protocol and visuals

### Reference event shape (event-sourced)

```
step.started  → step.ended (finish, cost, tokens) | step.failed
text.started  → text.delta* → text.ended          (ended = authoritative full value)
reasoning.started → reasoning.delta* → reasoning.ended
tool.input.started → tool.input.ended → tool.running → tool.completed | tool.error
shell.started → shell.ended
```

Key detail: **`*.delta` events are `ephemeral`; only `*.ended` is durable.** Live fragments never hit the
event log, so a token stream costs no database writes and replay reads whole parts.

### Reference rendering

- Reasoning: **reduced opacity + italic**, expand/collapse with a session-wide
  "Expand thinking" / "Collapse thinking" command; a separate `showReasoningSummaries` toggle.
- Tool parts: separate default-open flags for shell and edit parts (`shellToolPartsExpanded`,
  `editToolPartsExpanded`).
- Parts are **paced** (`createPacedValue`) so a burst of deltas produces one paint, not one paint per delta.

### Deyin (after this pass)

- Reasoning: live block shows the stream with a blinking caret, finished block collapses to a one-line
  `Thought · Ns` disclosure; `Thinking · Ns` while live. Now italic, muted, hairline-left-bordered.
- Assistant text: blinking caret while streaming.
- New **run status strip** in the composer: pulsing phase dot (thinking / streaming / tool / waiting), the
  phase label, a live elapsed timer, and retry count when retrying. This was previously passed into the
  composer as `runStatus` and never rendered.
- Tool cards: status icon, tool badge, summary, duration, expandable result with auto-scroll, exit code.
- Deltas coalesced on `requestAnimationFrame` (`useAgentState.ts`), structural events immediately.

**Efficiency verdict.** Both systems cap paints to one per frame — that is the property that matters, and
both have it. The reference does one better on *I/O*: ephemeral deltas mean a long reasoning stream writes
nothing. Deyin batches in the view layer but still records deltas in the run timeline, so a very long
reasoning burst grows thread state. Conversely Deyin is faster on *framing*: the Rust path frames SSE/ACP/
NDJSON at ~0.2× the JS cost and counts tokens natively.

---

## 5. Plugins

The reference's most distinctive architectural choice: **every non-core shell feature is a plugin** —
terminal, review, files, browser, SSH, WSL, updater — all built on the same published SDK that third parties
use. A package exposes up to four entrypoints: `.`/`./server`, `./tui`, `./gui`, and `./rpc` (typed
contract). The GUI context is large and typed (`layout`, `sessions`, `screen`, `storage`, `system`,
`desktop`, `dialogs`, `toast`, `tabs`, `attention`, `commands`, `links`, `ui`, `app`, `locale`,
`appearance`, `router`, `keybinds`, `servers`, `workspaces`, plus a main-process context).

Deyin has plugins (manifest, bundled plugins, capability registry, per-plugin secrets) but no GUI plugin
surface: the UI is one app, not a shell plus plugins. Copying this is a multi-week architectural change, not
a refactor, and it is the reason the reference can ship a "files" or "browser" feature independently.

---

## 6. Settings information architecture

Reference: a vertical-tab dialog with two groups — **Desktop** (General, Shortcuts) and **Server**
(Providers, Models) — plus a separate **Extensions** surface with MCPs / Plugins / Skills subtabs. General
holds a collapsed "Advanced" block of visibility toggles.

Deyin (after this pass): six short groups instead of four mixed ones.

| Group | Pages |
| --- | --- |
| Desktop | General, Appearance |
| Models | Model settings, Model roles |
| Extensions | MCPs · Plugins · Skills (one page, three tabs) |
| Workspace | Terminal, Browser, Computer Use, Indexing |
| Data and statistics | Agent data |
| Deyin | Account, SSH hosts |

`integrations` + `skills` collapsed into one `extensions` page with subtabs, mirroring the reference and
removing a nav entry. Legacy page ids (`mcp`, `plugins`, `skills`, `capabilities`, …) still route, so stored
deep links do not break.

---

## 7. Where Deyin is more efficient (measured)

From `docs/PERFORMANCE_REPORT.md` (`pnpm --filter @deyin/agent-core exec tsx test/performance/run-benchmarks.ts`):

| Benchmark | Result | Target |
| --- | --- | --- |
| Prefix-cache hit rate, 100 turns | 89.6% | ≥ 80% |
| 1000-turn transcript fold | 2.0 ms | < 2000 ms |
| Streaming paint rate (p95) | 120 fps (capped) | ≥ 55 fps |
| `frameAcpChunk`, 50 JSON-RPC msgs | 0.2× JS time, byte-identical | identical |
| `frameNdjsonChunk`, 100 CLI events | 0.2× JS time, byte-identical | identical |
| `ringBufferAppend`, 200 log lines | 0.1× JS time, byte-identical | identical |

First-load web payload after code-splitting the secondary views (automations, superagent, bot workflows,
plans, settings):

| | Before | After |
| --- | --- | --- |
| Entry `index.js` | 684 KB raw / 204 KB gz | 537 KB raw / **158 KB gz** |
| First-load total (entry + react + markdown + vendor + css) | — | 1040 KB raw / **289 KB gz** |
| Lazy chunks produced | 0 | 5 (Settings 24 KB, Superagent 32 KB, Plans 23 KB, Workflows 16 KB, Automations 16 KB) |

---

## 8. Recommended next steps (ranked by leverage)

1. **`toolChoice: "none"` on the final step** — matches the reference's hard guarantee; Deyin currently
   relies on a user-role warning.
2. **Code Mode for MCP** — the largest request-size win available for anyone with a big MCP catalog.
3. **HTTP skill catalogs** — turns skills into something users install rather than author.
4. **Ephemeral deltas** — stop persisting reasoning/text deltas into the run timeline; keep only the
   `ended` value. Removes unbounded thread growth on long reasoning.
5. **Compatibility skill roots** (`.claude/skills`, `.agents/skills`) — free supply of existing skills.
6. **GUI plugin SDK** — the reference's structural advantage, and the largest single piece of work.
