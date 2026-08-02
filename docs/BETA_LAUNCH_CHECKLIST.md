# Beta Launch Checklist — Deyin 2.0.0

Immediate pre-beta gates before inviting the first cohort. This is narrower than the full [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) (GA sign-off).

## Must pass before beta invite

- [ ] `pnpm typecheck` — no errors across all workspaces
- [ ] `pnpm --filter @deyin/agent-core test:agent` — full 174-test Advanced agent suite green
- [ ] Manual GUI smoke test on at least one platform (launch, send message, settings migrate)
- [ ] Migration script tested — `tsx scripts/migrate-sessions.ts` exits 0 on missing sessions dir
- [ ] Feature flags verified: coordinator / fleet / delivery **OFF**, cache optimizations **ON**
- [ ] Discord `#agent-beta` channel ready and staffed
- [ ] Beta feedback form working (linked from in-app What's New / settings)
- [ ] Rollback procedure tested (disable flags → restore settings backup → prior build if needed)

## Quick verification commands

```bash
pnpm typecheck
pnpm --filter @deyin/agent-core test:agent
tsx scripts/migrate-sessions.ts /tmp/nonexistent-sessions-dir   # expect exit 0
pnpm --filter @deyin/desktop build
```

## Reference

- Rollout plan: [BETA_ROLLOUT.md](./BETA_ROLLOUT.md)
- User migration: [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)
- Full GA checklist: [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md)
