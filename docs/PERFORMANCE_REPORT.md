# Performance Report

**Generated**: 2026-09-02T00:32:55.140Z
**Status**: ✅ All targets met

## Benchmark Results

| Benchmark | Metric | Result | Target | Status |
|-----------|--------|--------|--------|--------|
| Cache | Hit rate (100 turns) | 89.6% | ≥80% | ✅ |
| UI | 1000-turn load | 0.4ms | <2000ms | ✅ |
| UI | Streaming FPS (p95) | 120.0 | ≥55 | ✅ |
| Native | Module loaded | yes | — | ✅ |
| Native | countTokens (12KB prose) | 1.0x (identical=true) | identical | ✅ |
| Native | compressToolOutput (40KB log) | 1.0x (identical=true) | identical | ✅ |
| Native | nativeGrep (0 hits, in-process) | 1.0x (identical=true) | identical | ✅ |
| Summary | Deterministic scenario | toolCalls=6, deniedCalls=1, failedCalls=3, duplicateResults=1, loopGuardTrips=1 | toolCalls=6, deniedCalls=1, failedCalls=3, duplicateResults=1, loopGuardTrips=1 | ✅ |
| Compaction | prune-short-circuit (window 200000) | action=prune, prune reclaimed 62000 tok, second pass 0 | action=prune, second pass 0 | ✅ |
| Compaction | fold-required (window 32000) | action=fold, prune reclaimed 0 tok, second pass 0 | action=fold, second pass 0 | ✅ |
| Compaction | stand-down (window 200000) | action=none, prune reclaimed 0 tok, second pass 0 | action=none, second pass 0 | ✅ |
| Compaction | Tail budget scaling | min(16k, 25% of window) | 32k→8k, 128k→16k | ✅ |
| Compaction | Fold fidelity | 5/11 facts survived | 5 (tail immune, pinned intact, cache-shaped request) | ✅ |

## Targets

- Cache hit rate: ≥80%
- 1000-turn load: <2s
- Streaming: ≥55fps (p95)
- Native outputs byte-identical to TS fallbacks
- Compaction: policy picks the expected action per scenario, prune is idempotent, folds preserve everything the summarizer returned
