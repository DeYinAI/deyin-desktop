# Release Checklist — Deyin 2.0.0

Major release: advanced agent architecture (Phases 1–7).

## Pre-release verification

| Item | Status |
|------|--------|
| Agent test suite (174 tests) | ✓ |
| Typecheck | ✓ (after blocker fixes) |
| Documentation complete | ✓ |
| Settings UI functional | ✓ |
| Migration tested (v9 → v10 settings, session backfill) | ✓ |
| Feature flags configured (coordinator/fleet/delivery off, cache on) | ✓ |
| Beta plan approved | ✓ |
| Rollback plan documented | ✓ |
| Benchmarks / cache guard | ✓ (CI) |

## Code & quality

- [x] `pnpm --filter @deyin/agent-core test:agent-suite` — full agent suite (174 tests)
- [x] `pnpm typecheck` — no errors
- [x] Cache guard: tail-average hit rate ≥85% (`packages/agent-core`, CI)
- [x] Coordinator tests pass
- [x] Fleet/scheduler tests pass
- [x] Delivery mode E2E tests pass
- [ ] `pnpm test` — all packages green (full monorepo via `scripts/verify.sh`)

## Documentation

- [x] [CACHE_ARCHITECTURE.md](./CACHE_ARCHITECTURE.md)
- [x] [EVIDENCE_DELIVERY.md](./EVIDENCE_DELIVERY.md)
- [x] [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)
- [x] [docs/guides/](./guides/) — all four guides

## Product

- [x] Settings: Cache, Coordinator, Scheduler, Evidence pages
- [x] Feature flags defaults: coordinator/fleet/delivery **off**, cache **on**
- [x] What's New modal for 2.0
- [x] advanced agent onboard flow
- [ ] Beta feedback form (verify URL before beta invite)
- [x] Help tooltips on advanced agent settings

## Observability

- [x] Cache prefix change logging with attribution
- [x] Coordinator routing decision logging
- [x] Fleet coordination event logging
- [x] Evidence gate rejection logging
- [x] Telemetry events (opt-in)
- [x] Developer diagnostics panels
- [ ] Weekly metrics report generation (post-beta ops)

## Release engineering

- [ ] Version `2.0.0` in `apps/desktop/package.json` and root `package.json`
- [x] [CHANGELOG.md](./CHANGELOG.md) updated
- [ ] Release notes draft (GitHub Releases)
- [ ] Electron build succeeds (`pnpm --filter @deyin/desktop package`)
- [ ] Smoke test packaged build on Windows/macOS/Linux

## Post-release

- [ ] Monitor beta metrics first 48h
- [ ] Discord `Deyin Discord` staffed
- [ ] First weekly sync scheduled

## Sign-off

| Role | Name | Date |
|------|------|------|
| Engineering | | |
| Product | | |
| QA | | |
