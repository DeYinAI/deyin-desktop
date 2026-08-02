# Fleet Orchestration Guide

**Status**: Production-ready (Phase 3)

## Overview

Fleet coordinates **2–64 parallel subagent tasks** with write-path preflight, session-scoped concurrency, and background job persistence. Enable via Settings → Fleet & scheduler → **Fleet orchestration** (`enableFleet`).

Implementation: `packages/agent-core/src/tools/fleet.ts`, `scheduler/`, `jobs/`.

## Write-path claim syntax

Each fleet task that writes files must declare `write_paths` — absolute or workspace-relative paths **without globs**:

```json
{
  "tasks": [
    {
      "profile": "explorer",
      "prompt": "Refactor auth middleware in src/auth/",
      "write_paths": ["src/auth/middleware.ts", "src/auth/session.ts"]
    },
    {
      "profile": "test-runner",
      "prompt": "Update auth tests",
      "write_paths": ["tests/auth/"]
    }
  ]
}
```

### Rules

| Case | Behavior |
|------|----------|
| Writer omits `write_paths` | Claims **whole workspace** (exclusive with other writers) |
| `read_only: true` | No write claim; runs as reader |
| Subagent profile is read-only | Treated as reader regardless of paths |
| Overlapping paths | **Preflight fails** before any task starts |
| Paths outside workspace | Validation error |
| Globs (`*`, `?`) | Rejected |

### Path overlap examples

```
Task A: write_paths=["src/components/"]
Task B: write_paths=["src/components/Button.tsx"]
→ CONFLICT (B is inside A)

Task A: write_paths=["src/auth/"]
Task B: write_paths=["src/billing/"]
→ OK (disjoint)

Task A: (no write_paths, writer)
Task B: write_paths=["src/anything.ts"]
→ CONFLICT (A claims whole workspace)
```

## Conflict resolution strategies

1. **Preflight reject (default)** — `schedulerWritePathValidation: true` validates all claims before spawning tasks. Zero partial writes on conflict.

2. **Disable preflight (not recommended)** — Set Settings → Fleet & scheduler → Preflight write_paths off. Overlapping writers may race; use only for read-only fleet runs.

3. **Agent recovery** — On preflight error, the model receives `ERROR: fleet preflight: write path conflict between task N and M`. It should repartition paths and retry.

4. **Parent write reservation** — Parent agent can call `reserveParentWrite` to block subagents from conflicting paths while the parent edits.

## Background job patterns

### Fire-and-forget

```json
{
  "tool": "task",
  "arguments": {
    "prompt": "Run full test suite and summarize failures",
    "profile": "test-runner",
    "is_background": true
  }
}
```

Returns a **job ID immediately**. Completion notes appear as system reminders on the next turn.

### Wait for multiple jobs

```json
{
  "tool": "wait",
  "arguments": {
    "job_ids": ["uuid-1", "uuid-2"],
    "timeout_ms": 120000
  }
}
```

Jobs persist in JSONL under `<userData>/sessions/` for the session lifetime.

## Scheduler configuration tuning

Settings → Fleet & scheduler:

| Setting | Default | Guidance |
|---------|---------|----------|
| `maxSubagentConcurrency` | 6 | Total parallel slots (readers + writers) |
| `maxParallelWriters` | 3 | Cap concurrent writers with path claims |
| `schedulerWritePathValidation` | true | Keep on for production |

**Tuning tips**:

- CPU-bound repos: lower concurrency (4 total, 2 writers)
- Read-heavy fleet (explore + search): raise total concurrency; writers stay low
- Nested subagents: fail fast when capacity exhausted (avoids deadlock)

## Observability

- Settings → Fleet & scheduler → **Fleet execution timeline**
- Log lines: `[fleet] preflight|start|complete|conflict` in `deyin.log`
- Metrics: fleet runs, conflicts, background jobs (weekly aggregate)

## Testing

```bash
cd packages/agent-core
npm test -- test/fleet.test.ts test/scheduler.test.ts
```

## Related

- [COORDINATOR.md](./COORDINATOR.md) — planner routing (orthogonal to fleet)
- [docs/guides/fleet-coordination-examples.md](./guides/fleet-coordination-examples.md) — scenarios
