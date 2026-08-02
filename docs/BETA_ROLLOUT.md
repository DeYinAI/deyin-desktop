# Beta Rollout Plan — Advanced agent Integration

**Target release**: Deyin 2.0.0  
**Feature flags**: coordinator, fleet, delivery off by default; cache optimizations on.

## Phase A: Internal testing (2 weeks)

### Checklist

- [ ] All `packages/agent-core` tests pass
- [ ] Cache guard ≥80% hit rate on 50-turn scenario
- [ ] Coordinator routing scenarios manually verified
- [ ] Fleet write-path conflict preflight verified
- [ ] Delivery mode E2E loop passes
- [ ] Settings UI: cache, coordinator, scheduler, evidence pages functional
- [ ] Observability: `deyin.log` attribution, diagnostics panels, metrics JSON
- [ ] Migration from v9 → v10 settings on clean and dirty profiles
- [ ] Rollback: disable flags + restore settings backup

### Owners

- Engineering: daily dogfood with flags enabled individually
- QA: regression on agent, plan, ask modes with flags **off** (default path)

## Phase B: Beta user selection (4 weeks)

### Selection criteria

- Active Deyin desktop users with ≥10 agent sessions/week
- Mix of DeepSeek, OpenAI-compatible, and Openference providers
- At least 30% multi-file refactor use cases
- Willing to enable telemetry (anonymous aggregates)
- Available for weekly 15-min feedback sync

### Onboarding

1. What's New modal on first 2.0 launch
2. Advanced agent onboard flow → Settings → Prefix cache
3. Discord `#agent-beta` channel (see below)
4. In-app beta feedback form (Help menu or Settings)

### Discord channel setup

1. Create `#agent-beta` on the Deyin Discord server
2. Pin links: `docs/BETA_ROLLOUT.md`, `docs/MIGRATION_GUIDE.md`, feedback form instructions
3. Weekly office hours (30 min) for live debugging
4. Escalation: `@agent-oncall` role for P0 cache/coordinator regressions

### Weekly sync template

```markdown
## Advanced agent Beta Sync — YYYY-MM-DD

### Metrics (from Settings → aggregated / agent-metrics.json)
- Cache hit rate: __%
- Coordinator runs / fallbacks: __ / __
- Fleet conflicts: __
- Evidence gate rejections: __

### Top 3 wins


### Top 3 issues


### Action items
- [ ] 
```

## Phase C: Gradual rollout (6 weeks)

| Week | Audience | Flags enabled by default |
|------|----------|--------------------------|
| 1–2 | Beta cohort only | None (manual opt-in) |
| 3–4 | 10% stable channel | `enableCacheOptimizations` (already on) |
| 5 | 50% stable channel | Consider `enableCoordinator` for new installs |
| 6 | 100% stable channel | Evaluate `enableFleet` default for power users |

Use release channel or remote config when available; until then, communicate via release notes.

## Phase D: GA readiness

- [ ] Cache hit rate ≥80% median across beta cohort
- [ ] Coordinator fallback rate &lt;10%
- [ ] Fleet conflict rate &lt;5% of fleet runs
- [ ] Zero P0 bugs open for 2 weeks
- [ ] Documentation complete (all `docs/` guides)
- [ ] [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) signed off
- [ ] Rollback tested on staging

## Rollback plan

### Trigger conditions

- Session-wide cache hit rate drops below 50% for majority of users
- Data loss or corruption in sessions/evidence ledger
- Coordinator/fleet causes widespread failed runs

### Steps

1. **Immediate**: Ship patch with all Advanced agent flags forced `false` via settings migration default override
2. **Communicate**: Discord + in-app banner with rollback notice
3. **Preserve data**: Do not delete `sessions/` or `agent-metrics.json`
4. **Root cause**: Use `deyin.log` + diagnostics upload
5. **Re-enable**: Per-feature flag flip after fix verified in Phase A checklist

### Rollback verification

- Default user path identical to pre-2.0 behavior
- Existing threads continue without coordinator/fleet/delivery
- Cache optimizations can remain on if isolated as cause

## Feedback collection

- **In-app**: Beta feedback form → `beta-feedback.jsonl` in userData
- **Telemetry** (opt-in): `cache-hit`, `coordinator-run`, `fleet-conflict`, `evidence-gate` events
- **Discord**: `#agent-beta`
- **Weekly reports**: `agent-weekly-YYYY-Www.json` auto-generated in userData

## Success criteria for GA

See [AGENT_INTEGRATION_STATUS.md](./AGENT_INTEGRATION_STATUS.md) and [METRICS_BASELINE_REPORT.md](./METRICS_BASELINE_REPORT.md).
