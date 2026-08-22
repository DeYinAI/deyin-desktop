# Native Hot Path (`@deyin/native-core`)

All algorithms are implemented in-house in Rust (`native/deyin-native/`) —
no third-party algorithm crates. `napi` is used purely as Node binding glue.
When the `.node` binary is unavailable (wrong platform, not built), every call
transparently falls back to the TypeScript implementation. Callers never branch.

## Modules

| Module | Rust | TS fallback | Used by |
|--------|------|-------------|---------|
| SSE framing | `src/sse.rs` — incremental chunk framing, zero regexes, single pass | `host-core/src/sse.ts` | streaming transports |
| Token counting | `src/tokenizer.rs` — cl100k-style heuristic, zero-allocation run scanner | `agent-core/src/tokenizer.ts` | compaction budgets, compression metrics |
| Wire compression | `src/compress.rs` — byte-faithful port of `compressToolOutput` | `agent-core/src/compression.ts` | all wire serializers (`wire.ts`) |
| Grep engine | `src/grep.rs` — parallel literal/regex-subset search with gitignore-style skips | ripgrep spawn → JS walk (`tools/grep.ts`) | grep tool |

## Build

```bash
pnpm --filter @deyin/native-core build          # cargo build --release + copy
pnpm --filter @deyin/native-core build:debug    # debug build
```

Requires `cargo` on PATH. CI builds it when available; otherwise tests still
pass via TS fallbacks.

## Integration points

- `agent-core/src/native.ts` — synchronous loader (`createRequire` from ESM),
  exposes `fastCountTokens`, `fastTruncateToTokens`, `fastCompressToolOutput`,
  `nativeGrep`. All return TS-equivalent results or fall back.
- `compression.ts` routes `compressToolOutput` through the native path first.
- `tools/grep.ts` prefers the native in-process engine over spawning ripgrep.

## Correctness guarantee

The Rust compressor is a byte-for-byte port of `compressToolOutput`.
`src/compression-parity.test.ts` (wired into `pnpm test`) asserts identical
output across log/duplicate/error/ANSI/long-line/conservative scenarios.

## Measured speedup

From `test/performance/native-benchmark.ts` (WSL2, Rust 1.97, Node 22):

```
countTokens (12KB prose):        ts=355.8ms  native=37.9ms   9.4x
compressToolOutput (40KB log):   ts=122.7ms  native=108.0ms  1.1x*
nativeGrep (in-process):         no process spawn; ~1.5ms warm for repo-local search
```

*Compression speedup is modest because most time is UTF-16 ↔ UTF-8 boundary
conversion across the napi bridge; the win grows with payload size.

## Token / request metrics (before → after optimization pass)

Measured against simulated 50-turn tool-loop sessions (see
`src/testing/cache-guard.ts`; provider-reported usage):

| Metric | Before | After |
|--------|--------|-------|
| Session prompt cache hit rate | ~55–70% (unstable keys, per-model suffix) | ≥88% stable-prefix target (0.85 guard threshold) |
| Prompt cache key stability across model routing | per-model key → full re-read on router switch | single session key → prefix survives routing |
| Duplicate `optimization` events per tool loop step | 2 (loop + post-tool emit) | 1 |
| Subagent wire options | inherited nothing (no compression/caching flags) | inherit parent `wire` (compression + caching parity) |
| DeepSeek max_tokens | provider default (~4k) → frequent length-truncation continuations | 8192 → continuation requests eliminated |
| Tool output wire size (40KB noisy bash log) | full tokens | ~10x smaller via dedup/timestamp-strip/error-priority |
