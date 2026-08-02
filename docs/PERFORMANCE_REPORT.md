# Performance Report

**Generated**: 2026-08-02T17:40:53.903Z
**Status**: ✅ All targets met

## Benchmark Results

| Benchmark | Metric | Result | Target | Status |
|-----------|--------|--------|--------|--------|
| Cache | Hit rate (100 turns) | 89.6% | ≥80% | ✅ |
| UI | 1000-turn load | 0.4ms | <2000ms | ✅ |
| UI | Streaming FPS (p95) | 120.0 | ≥55 | ✅ |
| Coordinator | Routing overhead | 0.92µs | <500µs | ✅ |
| Fleet | Parallel speedup (8 tasks) | 7.84x | 2–8x | ✅ |

## Targets

- Cache hit rate: ≥80%
- 1000-turn load: <2s
- Streaming: ≥55fps (p95)
- Parallel execution: 2–4x speedup
- Coordinator routing: <500µs avg
