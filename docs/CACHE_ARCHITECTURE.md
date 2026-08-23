# Cache Architecture Guide

**Status**: Phase 1 Production Ready  
**Reference**: Deyin prefix-cache architecture

## Overview

Deyin uses a cache-first architecture targeting **≥80% prefix cache hit rate** in multi-turn agent sessions. The cache key is the byte-identical prefix sent to the provider:

1. System prompt (deterministic build)
2. Tool schemas (sorted names, canonical JSON)
3. Conversation history (append-only until compaction)

Implementation lives in `packages/agent-core/src/cache/`.

## Prefix Stability

### System prompt hash

`hashSystemPrompt()` SHA-256 hashes the full system message. Rebuilds must produce identical bytes:

- Base agent prompt
- Memory index, skills summary
- Environment snapshot (24h TTL)
- Mode instructions

**Rule**: Never mutate the system block mid-turn. Rebuild only on session boot or explicit mode change.

### Tool schema hash

`hashToolSchemas()` sorts tools by name and serializes with `canonicalizeToolSchemas()` (recursive key sort). Identical logical toolsets → identical hash regardless of registration order.

**Rule**: Avoid adding/removing MCP tools mid-session when cache efficiency matters.

### Log rewrite version

`logRewriteVersion` bumps only on **hard compaction** (snip, prune, or drop). Soft warnings at 50% do not mutate the prefix.

```typescript
shouldBumpLogRewriteVersion(compaction) // true when truncated/dropped > 0
```

## Compaction Tiers

Compaction is the **only** prefix mutation point for conversation history:

| Threshold | Action | Cache impact |
|-----------|--------|--------------|
| 50% | Soft warning (UI notice) | None |
| 60% | Snip stale tool results | Rewrites old tool content |
| 80% | Prune + summarize + drop groups | Full log rewrite |

User messages and the recent tail (last 8 messages) are preserved verbatim.

## DeepSeek Optimizations

### reasoning_content roundtrip

Assistant tool-call turns must include `reasoning_content` on history replay. Wire format (`wire.ts`):

```json
{ "role": "assistant", "content": null, "reasoning_content": "...", "tool_calls": [...] }
```

Missing reasoning degrades to `""` (graceful, avoids 400 errors).

### Beta prefix continuation

When `finish_reason === "length"` and no incomplete tool calls, `stream.ts` automatically:

1. Appends `{ role: "assistant", content: "<partial>", prefix: true }` to messages
2. POSTs to `/beta/chat/completions`
3. Folds usage from both requests

Non-DeepSeek providers skip continuation (no behavior change).

### Usage fields

DeepSeek reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`. These map to `cachedPromptTokens` in `TokenUsage`.

## Diagnostics & UI

### Per-turn diagnostics

`comparePrefixShapes()` returns:

- `prefixChanged` — whether system, tools, or log_rewrite differ
- `changeReasons` — `["system" | "tools" | "log_rewrite"]`
- `hit` / `miss` — token counts for this request

### Session aggregate

`OptimizationTracker.recordPrefixShape()` accumulates `sessionCacheHit` / `sessionCacheMiss` across all steps.

### Desktop UI

- **TopBar**: Color-coded cache hit % (green ≥80%, yellow ≥50%, red <50%)
- **Composer context ring**: Green <70%, yellow <90%, red ≥90% context fill
- **Context Usage popover**: Cache diagnostics in footer
- **Compaction notices**: Soft warning strip at 50%, card on hard compaction

## Debugging Cache Misses

1. Check optimization event `changeReasons` in the run transcript.
2. If `system`: system prompt rebuilt — check mode/env/skills changes.
3. If `tools`: tool registry changed — check MCP connect/disconnect.
4. If `log_rewrite`: compaction ran — expected; hit rate should recover next turn.
5. Run cache guard: `npm test -- src/cache/__tests__/cache-guard.test.ts`

## Testing

| Test file | Coverage |
|-----------|----------|
| `src/cache/__tests__/prefix-tracker.test.ts` | Hash stability, churn attribution, compaction version |
| `src/cache/__tests__/wire-reasoning.test.ts` | reasoning_content roundtrip |
| `src/cache/__tests__/stream-continuation.test.ts` | Beta endpoint continuation |
| `src/cache/__tests__/cache-guard.test.ts` | 50-turn hit rate ≥80% |
| `src/testing/cache-guard.ts` | Scenario runner for CI |

## Graceful Degradation

| Provider | Behavior |
|----------|----------|
| DeepSeek | Full prefix cache + beta continuation + reasoning roundtrip |
| OpenAI / Openference | `prompt_cache_key` + cached_tokens tracking |
| Anthropic | `cache_control` on system block |
| Other | No cache markers; metrics show 0% hit rate without errors |

## Performance Targets

- Session average cache hit rate: **≥80%**
- Prefix invalidations per 100 turns: **≤5**
- Compaction frequency: **≤1 per 50 turns**
- Token cost reduction vs no-cache baseline: **30–50%** (provider-dependent)

See [archive/CACHE_PERFORMANCE_REPORT.md](./archive/CACHE_PERFORMANCE_REPORT.md) for validation results.

## Tool schema canonicalization examples

Identical logical toolsets must produce identical `toolsHash` bytes:

```typescript
// Registration order does not matter — names are sorted first.
const schemasA = [writeToolSchema, readToolSchema, grepToolSchema];
const schemasB = [grepToolSchema, readToolSchema, writeToolSchema];
hashToolSchemas(schemasA) === hashToolSchemas(schemasB); // true
```

Object keys inside each schema are recursively sorted:

```json
// Input (unordered keys)
{ "function": { "name": "read", "parameters": { "properties": { "path": { "type": "string" }, "offset": { "type": "number" } } } } }

// Canonical bytes (sorted keys at every level)
{"function":{"name":"read","parameters":{"properties":{"offset":{"type":"number"},"path":{"type":"string"}}}}}
```

**Practical rule**: Connect/disconnect MCP servers mid-session changes `toolsHash` and invalidates the prefix. Prefer stable MCP configuration during long cache-sensitive sessions.

## Environment snapshot caching

The system prompt includes an environment snapshot (OS, shell, workspace metadata) with a **24-hour TTL**:

- Rebuilt on session boot and after TTL expiry
- Changes `systemHash` once per day at most under stable config
- Does not mutate mid-turn

To minimize system invalidations:

- Avoid toggling skills/MCP/plugins during active multi-turn runs
- Mode changes (agent → plan) rebuild the system block intentionally

## Performance tuning guide

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Hit rate &lt;50% after turn 5 | Tool registry churn | Stabilize MCP connections; check Settings → Prefix cache diagnostics |
| Frequent `log_rewrite` | Context compaction | Expected after long sessions; rate should recover next turn |
| Frequent `system` | Mode/env/skills change | Reduce mode switching; check environment snapshot TTL |
| Hit rate good but cost high | Compression off | Enable Optimization → Compress payloads |
| DeepSeek 400 on replay | Missing reasoning | Ensure `reasoning_content` roundtrip (automatic in agent-core) |

**Settings knobs** (Settings → Prefix cache):

- `enableCacheOptimizations` — master switch (default on)
- `cacheHitRateTarget` — green indicator threshold (default 80%)
- `cacheHitRateWarningThreshold` — yellow/red threshold (default 50%)

**Clear thread cache stats**: Settings → Prefix cache → Developer diagnostics → Clear thread cache stats (resets observability counters, not provider cache).

## Debugging cache misses (extended workflow)

1. Open **Settings → Prefix cache → Cache diagnostics** for the active thread.
2. Check **Invalidation history** for `system`, `tools`, or `log_rewrite`.
3. Compare `prefixHash` before/after the miss — if only `logRewriteVersion` changed, compaction caused it.
4. If `tools` changed, list MCP servers in Settings → MCP and note recent connect/disconnect.
5. If `system` changed, note mode switch, skill toggle, or 24h environment snapshot refresh.
6. Run the cache guard locally:

```bash
cd packages/agent-core
npm test -- src/cache/__tests__/cache-guard.test.ts
```

7. Enable telemetry (Settings → General) to contribute anonymous aggregate hit rates during beta.

