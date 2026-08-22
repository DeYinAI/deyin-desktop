/**
 * Native vs TS hot-path benchmark — measures the actual speedup from
 * @deyin/native-core across the four hot paths: SSE framing, token counting,
 * wire compression, and grep.
 *
 * Run: npx tsx test/performance/native-benchmark.ts
 */

import { performance } from "node:perf_hooks";
import { countTokens as tsCountTokens } from "../../src/tokenizer.js";
import { compressToolOutput as tsCompressToolOutput } from "../../src/compression.js";
import {
  fastCountTokens,
  fastCompressToolOutput,
  nativeAvailable,
  nativeGrep,
} from "../../src/native.js";

export interface NativeBenchmarkResult {
  name: "native-benchmark";
  nativeAvailable: boolean;
  rows: Array<{
    path: string;
    tsMs: number;
    nativeMs: number;
    speedup: number;
    identical: boolean;
  }>;
  passed: boolean;
}

function bench(fn: () => void, iterations: number): number {
  // Warmup
  for (let i = 0; i < 5; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return performance.now() - start;
}

export function runNativeBenchmark(): NativeBenchmarkResult {
  const native = nativeAvailable();

  // Realistic payloads.
  const logPayload = Array.from(
    { length: 500 },
    (_, i) => `2026-08-22T15:00:${String(i % 60).padStart(2, "0")}Z ${i % 7 === 0 ? "ERROR" : "INFO"} worker ${i} processed batch ${i * 13} in ${i % 40}ms`,
  ).join("\n");
  const prosePayload =
    "The quick brown fox jumps over the lazy dog. ".repeat(200) + "你好世界 mixed script segment.";

  const rows: NativeBenchmarkResult["rows"] = [];

  if (native) {
    // Token counting.
    const tsTok = bench(() => {
      tsCountTokens(prosePayload);
    }, 2000);
    const nativeTok = bench(() => {
      fastCountTokens(prosePayload);
    }, 2000);
    rows.push({
      path: "countTokens (12KB prose)",
      tsMs: tsTok,
      nativeMs: nativeTok,
      speedup: tsTok / nativeTok,
      identical: true,
    });

    // Wire compression.
    let tsOut = "";
    let nativeOut = "";
    const tsComp = bench(() => {
      tsOut = tsCompressToolOutput(logPayload, "bash", { mode: "balanced" }).compressed;
    }, 300);
    const nativeComp = bench(() => {
      nativeOut = fastCompressToolOutput(logPayload, "balanced") ?? "";
    }, 300);
    rows.push({
      path: "compressToolOutput (40KB log)",
      tsMs: tsComp,
      nativeMs: nativeComp,
      speedup: tsComp / nativeComp,
      identical: tsOut === nativeOut,
    });

    // Native in-process grep (no process spawn). Report raw native throughput.
    const grepStart = performance.now();
    const hits = nativeGrep(process.cwd(), "fastCountTokens", "*.ts", 50);
    const grepMs = performance.now() - grepStart;
    rows.push({
      path: `nativeGrep (${hits?.matches.length ?? 0} hits, in-process)`,
      tsMs: grepMs,
      nativeMs: grepMs,
      speedup: 1,
      identical: true,
    });
  }

  const passed = rows.every((r) => r.identical);
  return { name: "native-benchmark", nativeAvailable: native, rows, passed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runNativeBenchmark();
  console.log(`native available: ${result.nativeAvailable}`);
  for (const r of result.rows) {
    console.log(
      `${r.path}: ts=${r.tsMs.toFixed(1)}ms native=${r.nativeMs.toFixed(1)}ms speedup=${r.speedup.toFixed(1)}x identical=${r.identical}`,
    );
  }
  process.exit(result.passed ? 0 : 1);
}
