# Cache Performance Validation Report

**Date**: August 2, 2026  
**Phase**: Advanced Agent Features — Phase 1  
**Method**: Simulated multi-turn sessions via `packages/agent-core/src/testing/cache-guard.ts`

## Summary

| Scenario | Turns | Hit Rate | Target (≥80%) | Invalidations |
|----------|-------|----------|---------------|---------------|
| 50-turn stable prefix | 50 | ~88% | ✅ Pass | 0 |
| 50-turn with compaction | 50 | ~87% | ✅ Pass | 1 (log_rewrite @ turn 30) |
| 50-turn tool change | 50 | ~87% | ✅ Pass | 1 (tools @ turn 25) |
| 20-turn system churn | 20 | ~85% | ✅ Pass | 1 (system @ turn 10) |

All cache-guard scenarios pass the **≥80% session hit rate** target for multi-turn dialogue.

## Before / After (Phase 1)

| Metric | Before Phase 1 | After Phase 1 |
|--------|----------------|---------------|
| Prefix shape tracking | None | System + tools + rewrite version |
| Cache diagnostics | Raw cached_tokens only | Per-turn hit/miss + churn attribution |
| Compaction tiers | Single threshold | 50% warn / 60% snip / 80% prune |
| DeepSeek reasoning roundtrip | Missing on tool turns | `reasoning_content` on replay |
| Truncated response handling | Stop at `length` | Beta prefix continuation |
| UI observability | None | Status bar hit %, context ring, tooltips |

## Key Findings

1. **Stable prefixes dominate cost** — After the first turn, 85–90% of prompt tokens are cache hits when system prompt and tool schemas stay byte-identical.
2. **Compaction is the expected invalidation point** — A single `log_rewrite` bump per compaction event is normal; hit rate recovers on the next turn.
3. **Tool registry changes are rare but costly** — One tools-hash change invalidates the tool-schema prefix; keep MCP/tool surface stable within a session.
4. **System prompt churn should be avoided mid-session** — Environment snapshots and mode switches that rebuild the system block cause full prefix misses.

## Recommendations

- Keep tool schemas stable across turns (avoid dynamic MCP registration mid-run).
- Prefer tiered compaction (soft warning at 50%) over aggressive early rewrites.
- Use DeepSeek beta continuation for `finish_reason: "length"` to avoid truncated assistant output.
- Monitor the status bar cache indicator; sustained <50% hit rate indicates prefix churn.

## Running the Guard Locally

```bash
cd packages/agent-core
npm test -- src/cache/__tests__/cache-guard.test.ts
```

## CI Integration

Add to CI pipeline:

```bash
npm test --workspace=@deyin/agent-core -- src/cache/__tests__/cache-guard.test.ts
```

Target: `SESSION_HIT_RATE_TARGET = 0.8`, tail-average `CACHE_HIT_RATE_TARGET = 0.85`.
