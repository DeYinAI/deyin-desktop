# Agent Metrics — Baseline Report

**Generated**: August 2, 2026  
**Release**: Deyin 2.0.0 beta  
**Scope**: Internal validation + Phase 6 benchmarks

## Summary

Initial baseline from integration testing and cache guard scenarios. Use as comparison for weekly beta reports (`agent-weekly-*.json`).

## Cache performance

| Metric | Baseline | Target |
|--------|----------|--------|
| Session average hit rate | 82–88% | ≥80% |
| Prefix invalidations / 100 turns | 3–5 | ≤5 |
| Compaction frequency | ~1 / 50 turns | ≤1 / 50 |
| Token cost reduction vs no-cache | 35–45% | 30–50% |

Source: [CACHE_PERFORMANCE_REPORT.md](./CACHE_PERFORMANCE_REPORT.md), `cache-guard.test.ts`.

## Coordinator effectiveness

| Metric | Baseline | Notes |
|--------|----------|-------|
| Routing accuracy (fixture suite) | 100% | `test/coordinator.test.ts` |
| Planner invocation rate | ~35% of agent turns | Balanced policy, synthetic workload |
| Fallback rate | &lt;5% | Planner API errors simulated |
| Executor cache impact | None | Isolated sessions |

## Fleet coordination

| Metric | Baseline | Notes |
|--------|----------|-------|
| Preflight conflict detection | 100% | Overlapping paths rejected |
| Parallel speedup (4 read tasks) | ~3.2× | vs sequential |
| Job completion rate | 98%+ | Background jobs in test harness |
| Write-path conflict rate (beta target) | &lt;5% | Agent repartitions and retries |

## UI performance

| Metric | Baseline | Target |
|--------|----------|--------|
| Settings advanced agent pages load | &lt;120ms | &lt;200ms |
| Diagnostics refresh (IPC) | &lt;50ms | &lt;100ms |
| 1000-turn session initial render | TBD Phase 4 | &lt;2s |

## Evidence / delivery

| Metric | Baseline |
|--------|----------|
| Gate rejection recovery rate | 95%+ in E2E tests |
| Sign-offs per delivery session | 3–8 typical |

## Automated weekly reports

When telemetry is enabled, the desktop host:

1. Aggregates counters in `agent-metrics.json`
2. Every 7 days writes `agent-weekly-YYYY-Www.json`
3. Logs summary line to `deyin.log`

View current snapshot: Settings → any advanced agent page (stats cards) or IPC `agent.metrics()`.

## Next review

After Phase B beta week 2 — compare cohort metrics to this baseline and update targets if needed.
