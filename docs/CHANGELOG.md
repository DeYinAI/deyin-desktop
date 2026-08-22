# Changelog

## 2.0.0 — 2026-08-02

### Major: advanced agent architecture

Production-ready integration of cache-first architecture, two-model coordination, fleet orchestration, and delivery mode with evidence gates.

#### Prefix cache (Phase 1)

- Prefix stability tracking with system/tools/log_rewrite attribution
- Tiered compaction (50% soft warning, 60% snip, 80% prune)
- DeepSeek reasoning roundtrip and beta continuation endpoint
- Cache hit rate in TopBar and Settings → Prefix cache diagnostics

#### Coordinator (Phase 2)

- Planner/executor isolated sessions with deterministic routing
- Configurable routing policy: balanced, conservative, aggressive
- Feature flag: `enableCoordinator` (default off)

#### Fleet & scheduler (Phase 3)

- Fleet tool with write-path preflight and parallel execution
- Background jobs with JSONL persistence and `wait` tool
- Feature flag: `enableFleet` (default off)

#### Delivery mode (Phase 5)

- Evidence ledger, readiness gates, `complete_step` sign-offs
- Feature flag: `enableDeliveryMode` (default off)

#### Settings & UX (Phase 7)

- New settings section: Advanced agent features (cache, coordinator, scheduler, evidence)
- What's New modal, advanced agent onboard flow, beta feedback form
- Developer diagnostics: cache prefix, coordinator log, fleet timeline

#### Observability

- Structured logging to `deyin.log` for cache, coordinator, fleet, evidence events
- Privacy-respecting metrics in `agent-metrics.json`
- Automated weekly reports in userData

### Migration

- Settings schema v10 — see [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)
- Existing sessions compatible; cache stats appear on next run

### Defaults

| Flag | Default |
|------|---------|
| `enableCacheOptimizations` | `true` |
| `enableCoordinator` | `false` |
| `enableFleet` | `false` |
| `enableDeliveryMode` | `false` |

## Prior releases

See [RELEASE.md](./RELEASE.md) for 0.x history.
