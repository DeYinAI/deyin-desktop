# Performance Report

**Generated**: 2026-08-22T17:25:25.671Z
**Status**: ✅ All targets met

## Benchmark Results

| Benchmark | Metric | Result | Target | Status |
|-----------|--------|--------|--------|--------|
| Cache | Hit rate (100 turns) | 89.6% | ≥80% | ✅ |
| UI | 1000-turn load | 0.5ms | <2000ms | ✅ |
| UI | Streaming FPS (p95) | 120.0 | ≥55 | ✅ |
| Native | Module loaded | yes | — | ✅ |
| Native | countTokens (12KB prose) | 9.5x (identical=true) | identical | ✅ |
| Native | compressToolOutput (40KB log) | 1.0x (identical=true) | identical | ✅ |
| Native | nativeGrep (4 hits, in-process) | 1.0x (identical=true) | identical | ✅ |

## Targets

- Cache hit rate: ≥80%
- 1000-turn load: <2s
- Streaming: ≥55fps (p95)
- Native outputs byte-identical to TS fallbacks
