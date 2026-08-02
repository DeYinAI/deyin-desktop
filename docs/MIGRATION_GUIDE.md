# Migration Guide — Deyin 2.0 (Advanced agent Integration)

Upgrade from Deyin 0.x/1.x to **2.0.0** with the Deyin agent integration.

## Before you upgrade

1. **Back up** your Deyin data directory — especially `settings.json` and `sessions/`:
   - **Desktop app**: `~/.config/Deyin/` on Linux, `~/Library/Application Support/Deyin/` on macOS, `%APPDATA%\Deyin\` on Windows
   - **CLI**: `~/.deyin/` (sessions at `~/.deyin/sessions/`)
2. Note your current `plannerModel`, concurrency, and optimization settings.
3. Review [BETA_ROLLOUT.md](./BETA_ROLLOUT.md) if joining the beta program.

## Automatic migrations

On first launch, `SettingsStore` migrates to **schema version 10**:

| Field | Default (new installs) | Existing users |
|-------|------------------------|----------------|
| `enableCoordinator` | `false` | `false` (opt-in) |
| `enableFleet` | `false` | `false` (opt-in) |
| `enableDeliveryMode` | `false` | `false` (opt-in) |
| `enableCacheOptimizations` | `true` | `true` |
| `plannerModel` | `null` | Preserved if already set |
| `maxSubagentConcurrency` | `6` | Preserved |
| `maxParallelWriters` | `3` | Preserved |
| `coordinatorRoutingPolicy` | `balanced` | `balanced` |
| `schedulerWritePathValidation` | `true` | `true` |

CLI config (`deyin.json`) v9 fields (`plannerModel`, `scheduler`) continue to work via `packages/agent-core/src/migration/config-v9.ts`.

## Session format

Agent sessions may include optional cache metadata on optimization events:

- `prefixHash`, `changeReasons` — per-turn diagnostics
- `sessionCacheHit` / `sessionCacheMiss` — aggregate counters

Older sessions load unchanged; new fields appear on the next agent run.

### Session backfill script

To backfill v2 cache metadata on existing JSONL transcripts:

```bash
# Desktop sessions (default userData path on Linux)
tsx scripts/migrate-sessions.ts ~/.config/Deyin/sessions

# CLI sessions
tsx scripts/migrate-sessions.ts ~/.deyin/sessions
```

If the sessions directory does not exist (fresh install), the script exits successfully with `No sessions to migrate`.

## Enabling features after upgrade

Recommended gradual rollout:

1. **Week 1** — Leave defaults (`enableCacheOptimizations` only). Monitor hit rate in status bar.
2. **Week 2** — Enable `enableCoordinator` + set `plannerModel` for one project.
3. **Week 3** — Enable `enableFleet` for parallel exploration tasks.
4. **Week 4** — Enable `enableDeliveryMode` for production shipping workflows.

All toggles: **Settings → Advanced agent integration**.

## Breaking changes

- **Delivery mode hidden** unless `enableDeliveryMode` is true (composer switcher).
- **Fleet tools hidden** unless `enableFleet` is true.
- **Coordinator inactive** unless `enableCoordinator` and `plannerModel` ≠ executor.
- Settings schema version bump may reset unknown keys (standard migration behavior).

## Rollback

1. Disable all Advanced agent feature flags in Settings.
2. Restore previous `settings.json` from backup if needed.
3. Reinstall prior app version from GitHub Releases if critical.

See [BETA_ROLLOUT.md](./BETA_ROLLOUT.md) rollback section for production incidents.

## Verification checklist

- [ ] App launches; settings migrate without error
- [ ] Existing threads load and continue
- [ ] Cache hit % visible in TopBar after a multi-turn run
- [ ] Coordinator/fleet/delivery toggles persist across restart
- [ ] `npm test` in `packages/agent-core` passes locally (optional)

## Support

- Integration status: [AGENT_INTEGRATION_STATUS.md](./AGENT_INTEGRATION_STATUS.md)
- Technical guides: [CACHE_ARCHITECTURE.md](./CACHE_ARCHITECTURE.md), [COORDINATOR.md](./COORDINATOR.md), [FLEET_ORCHESTRATION.md](./FLEET_ORCHESTRATION.md)
