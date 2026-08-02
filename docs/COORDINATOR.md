# Coordinator Guide

**Status**: Production-ready (Phase 2)

## Overview

Two-model planner/executor coordination with **isolated sessions** for cache stability. When `plannerModel` in settings differs from the executor model, the desktop host activates a `Coordinator` that routes each turn deterministically — no classifier model.

## Key Design

**Separate Sessions**: Planner and executor never share transcripts. Switching models inside one shared conversation would break the prefix and tank cache hits.

```
User message
     │
     ▼
┌─────────────┐     executor_only      ┌──────────┐
│   Router    │ ─────────────────────► │ Executor │
└─────────────┘                        └──────────┘
     │ plan_and_execute
     ▼
┌─────────────┐   structured handoff   ┌──────────┐
│   Planner   │ ─────────────────────► │ Executor │
│ (read-only) │                        │ (full)   │
└─────────────┘                        └──────────┘
```

## Routing Logic

Deterministic rules in `packages/agent-core/src/coordinator/planner-router.ts`:

| Route | When | Behavior |
|-------|------|----------|
| `executor_only` | Plan mode, ask mode, slash commands, atomic edits, contextual replies | Skip planner |
| `plan_and_execute` | Multi-file changes, ambiguous scope, high-risk work, active goals | Plan → execute |
| `plan_for_approval` | User says "plan first" | Plan → persist → wait for approval |
| `plan_only` | "just plan", "don't implement" | Plan without execution |

## When each route triggers (detailed)

### executor_only

- Composer is in **Plan** or **Ask** mode
- User message is a slash command (`/fix`, `/commit`, …)
- Short contextual reply: "yes", "continue", "looks good", "lgtm"
- Atomic single-file edit: "fix typo", "bump version", "update import"
- Simple request with ≤3 referenced files and no risk/ambiguity signals

### plan_and_execute

- More than N referenced file paths (N depends on routing policy — see below)
- Message matches multi-file patterns: "refactor across", "migrate", "rename everywhere"
- Ambiguous scope: "either X or Y", "not sure which approach"
- High-risk keywords: delete, migration, security, auth, production
- Active goal mode with non-atomic work

### plan_for_approval

- User explicitly asks: "plan first", "show me a plan", "need a plan"

### plan_only

- User explicitly asks: "just plan", "only plan", "don't implement", "research only"

## Configuring the planner model

1. Enable **Settings → Coordinator → Coordinator** (`enableCoordinator`).
2. Select a **Planner model** different from the executor (e.g. `deepseek-chat` planner + `GLM-5.2` executor).
3. Choose **Routing policy**:
   - **Balanced** — plan when >3 files, ambiguous, high-risk, or multi-file patterns (default)
   - **Conservative** — plan when >5 files or high-risk/ambiguous/multi-file (fewer planner calls)
   - **Aggressive** — plan when >2 files or goal-mode mutations (more planner calls)

Planner runs in an **isolated session** with read-only tools. Executor receives a structured handoff user message.

## Fallback behavior details

| Scenario | What happens | User-visible signal |
|----------|--------------|---------------------|
| Planner API error/timeout | Executor runs alone with `[planner failed: …]` note in handoff | `phase: fallback` event |
| No-op plan (`[no_changes]`) | Plan persisted; execution skipped | `phase: persisted` |
| plan_for_approval | Plan persisted; waits for user approval | `[planner_requires_approval]` marker |
| plan_only | Plan persisted in executor session for next turn | No execution step |
| Coordinator disabled | Direct executor path | No routing events |

Fallback is **automatic** — the user always gets a response. Check Settings → Coordinator → Fallbacks counter and decision log for beta diagnostics.

## Troubleshooting

| Issue | Check |
|-------|-------|
| Coordinator never activates | `enableCoordinator` on? `plannerModel` set and ≠ executor? Agent mode (not plan/ask)? |
| Every request uses planner | Switch routing policy to **Conservative** |
| Planner never runs | Switch to **Aggressive**; verify multi-file keywords in message |
| High fallback rate | Planner model availability; API key; context limits |
| Cache hit rate drops | Expected — planner uses separate session/key; executor cache unaffected |

See Settings → Coordinator → Developer diagnostics for per-thread routing log.

## Depths

- **light** (2 research rounds): Compact objective, 1–4 steps, touchpoints, verification
- **full** (6 research rounds): Verified touchpoints, risks, acceptance criteria, rollback

## Planner Tool Surface

Read-only subset exposed to the planner:

- `read`, `grep`, `glob`, `ls`, `codebase_search`, `websearch`, `web_fetch`
- `todo_write`, `todo_read`, `ask_question`, `read_session_context`
- `use_capability` — MCP proxy (preserves planner prefix cache)

**Excluded**: `write`, `edit`, `bash`, `task`, `fleet` (no recursion, no side effects)

## Handoff Protocol

Planner output is formatted as a structured executor user message (`Deyin executor handoff` marker) with:

1. Original task context
2. Planner output (research + plan)
3. Executor tool context (verified tool/MCP availability)
4. Executor instructions (validate assumptions, ignore planner capability claims)

Special markers:

- `[no_changes]` — no-op plan, persisted without execution
- `[planner_requires_approval]` — plan-for-approval path

## Fallback Behaviors

| Failure | Behavior |
|---------|----------|
| Planner timeout/error | Fall back to executor-only with failure note |
| No-op plan detected | Persist plan + assistant reply, skip execution |
| Plan-only route | Persist plan in executor session for next turn |

## Configuration

Settings (`DeyinSettings`):

```typescript
plannerModel: string | null        // e.g. "deepseek-chat" — must differ from executor
maxSubagentConcurrency: number     // default 6
maxParallelWriters: number         // default 3
```

Enable coordination by setting `plannerModel` to a different model than the executor in General settings.

## UI Events

The desktop host emits:

- `phase` — planner/executing/routing transitions
- `coordinator-routing` — `{ route, reason }` for transparency
- `background-job` — job completion notifications

## Fleet Orchestration (Phase 3)

See also scheduler + fleet tools in `packages/agent-core/src/scheduler/` and `tools/fleet.ts`:

- **Write-path preflight**: overlapping claims fail before any task starts
- **Scheduler**: session-scoped concurrency (readers parallel, writers exclusive)
- **Background jobs**: `task(is_background=true)` + `wait` tool with JSONL persistence

## Testing

```bash
cd packages/agent-core
npm test -- test/coordinator.test.ts test/scheduler.test.ts test/fleet.test.ts test/planner-agent.test.ts
```

Coverage includes routing accuracy, session isolation, handoff format, planner tool filtering, write-path overlap, fleet preflight, and job lifecycle.

## Reference

Implementation patterns adapted from [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) `internal/agent/coordinator.go`, `scheduler.go`, and `fleet.go`.
