# Edge Case Behaviors — Reasonix Integration

This document describes graceful degradation paths validated in Phase 6.

## Coordinator

| Scenario | Behavior |
|----------|----------|
| Planner timeout | Falls back to executor-only; user message annotated with `[Note: planner pass failed (timeout); proceeding executor-only.]` |
| Planner throws | Same fallback path; exception message included in annotation |
| No-op plan | Plan persisted to executor transcript; no execution |
| Plan for approval | Executor receives `[Awaiting approval]` prefix; no tool execution |

## Fleet

| Scenario | Behavior |
|----------|----------|
| Overlapping write paths | Preflight rejects entire fleet before any task starts |
| Partial task failure | Sibling tasks continue; aggregate report shows per-task `completed` / `failed` |
| Abort signal | Pending tasks marked `skipped` with `aborted` error |

## Cache

| Scenario | Behavior |
|----------|----------|
| Corrupted prefix hash | `invalidateCorruptedCacheStats()` resets hit counters; miss counters preserved |
| System prompt churn | Single invalidation attributed to `system` in diagnostics |
| Compaction | `log_rewrite` version bump; expected one-time hit rate dip |

## Background Jobs

| Scenario | Behavior |
|----------|----------|
| Crash with running jobs | On reload, `recoverStaleJobs()` marks stale `running` jobs as `failed` |
| Corrupt JSONL line | Skipped during load; valid jobs retained |

## Evidence / Delivery Mode

| Scenario | Behavior |
|----------|----------|
| Write without todos | Gate `no_todos`; tool result contains delivery gate message |
| Premature completion text | Gate blocks finalization; agent continues until sign-off |
| Missing verification command | `complete_step` rejects with actionable error |

## Session Migration

| Scenario | Behavior |
|----------|----------|
| v1 session (no schemaVersion) | Auto-upgraded on load; `prefixHash` and `cacheStats` backfilled |
| Rollback to v1 shape | `stripSessionV2Meta()` removes v2 fields; re-backfill restores v2 |
