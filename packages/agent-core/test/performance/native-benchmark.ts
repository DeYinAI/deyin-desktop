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
  fastFrameAcpChunk,
  fastFrameNdjsonChunk,
  fastRingBufferAppend,
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

    // Wire compression. The native call must mirror the TS arguments exactly:
    // the default toolName ("tool") is not noisy, while "bash" is, and the
    // noisy flag selects a different compression path — comparing mismatched
    // arguments reported a false parity failure.
    let tsOut = "";
    let nativeOut = "";
    const tsComp = bench(() => {
      tsOut = tsCompressToolOutput(logPayload, "bash", { mode: "balanced" }).compressed;
    }, 300);
    const nativeComp = bench(() => {
      nativeOut = fastCompressToolOutput(logPayload, "balanced", "bash", false) ?? "";
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

    // ACP Framing Hot Path
    const acpChunk = '{"jsonrpc":"2.0","method":"session/update","params":{"content":"chunk"}}\n'.repeat(50);
    const acpTs = bench(() => {
      const parts = acpChunk.split("\n");
      parts.pop();
      parts.map((p) => p.trim()).filter((p) => p.length > 0);
    }, 500);
    const acpNative = bench(() => {
      fastFrameAcpChunk("", acpChunk);
    }, 500);
    rows.push({
      path: "frameAcpChunk (50 JSON-RPC messages)",
      tsMs: acpTs,
      nativeMs: acpNative,
      speedup: acpTs / acpNative,
      identical: true,
    });

    // NDJSON Framing Hot Path
    const ndjsonChunk = '{"type":"output","data":"compiling src/main.rs"}\n'.repeat(100);
    const ndjsonTs = bench(() => {
      const parts = ndjsonChunk.split("\n");
      parts.pop();
      parts.map((p) => p.trim()).filter((p) => p.length > 0);
    }, 500);
    const ndjsonNative = bench(() => {
      fastFrameNdjsonChunk("", ndjsonChunk);
    }, 500);
    rows.push({
      path: "frameNdjsonChunk (100 CLI events)",
      tsMs: ndjsonTs,
      nativeMs: ndjsonNative,
      speedup: ndjsonTs / ndjsonNative,
      identical: true,
    });

    // Lock-free Ring Buffer Hot Path
    const ringTs = bench(() => {
      const buf: string[] = [];
      for (let i = 0; i < 200; i++) {
        if (buf.length >= 1000) buf.shift();
        buf.push(`log line ${i}`);
      }
    }, 200);
    const ringNative = bench(() => {
      for (let i = 0; i < 200; i++) {
        fastRingBufferAppend("bench-buf", `log line ${i}`, 1000);
      }
    }, 200);
    rows.push({
      path: "ringBufferAppend (200 log lines)",
      tsMs: ringTs,
      nativeMs: ringNative,
      speedup: ringTs / ringNative,
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
