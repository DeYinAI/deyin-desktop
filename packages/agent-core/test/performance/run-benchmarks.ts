/**
 * Run all Advanced agent performance benchmarks and emit a combined report.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCacheBenchmark } from "./cache-benchmark.js";
import { runNativeBenchmark } from "./native-benchmark.js";
import { runUiBenchmark } from "./ui-benchmark.js";

export interface PerformanceReport {
  generatedAt: string;
  allPassed: boolean;
  benchmarks: Array<
    | ReturnType<typeof runCacheBenchmark>
    | ReturnType<typeof runUiBenchmark>
    | ReturnType<typeof runNativeBenchmark>
  >;
}

export async function runAllBenchmarks(): Promise<PerformanceReport> {
  const cache = runCacheBenchmark();
  const ui = runUiBenchmark();
  const native = runNativeBenchmark();

  const benchmarks = [cache, ui, native];
  return {
    generatedAt: new Date().toISOString(),
    allPassed: benchmarks.every((b) => b.passed),
    benchmarks,
  };
}

function formatMarkdown(report: PerformanceReport): string {
  const lines = [
    "# Performance Report",
    "",
    `**Generated**: ${report.generatedAt}`,
    `**Status**: ${report.allPassed ? "✅ All targets met" : "❌ Targets missed"}`,
    "",
    "## Benchmark Results",
    "",
    "| Benchmark | Metric | Result | Target | Status |",
    "|-----------|--------|--------|--------|--------|",
  ];

  for (const b of report.benchmarks) {
    if (b.name === "cache-benchmark") {
      lines.push(`| Cache | Hit rate (${b.turns} turns) | ${(b.hitRate * 100).toFixed(1)}% | ≥${(b.target * 100).toFixed(0)}% | ${b.passed ? "✅" : "❌"} |`);
    } else if (b.name === "ui-benchmark") {
      lines.push(`| UI | ${b.turnCount}-turn load | ${b.loadTimeMs.toFixed(1)}ms | <${b.loadTargetMs}ms | ${b.loadTimeMs < b.loadTargetMs ? "✅" : "❌"} |`);
      lines.push(`| UI | Streaming FPS (p95) | ${b.streamingFpsP95.toFixed(1)} | ≥${b.streamingTargetFps} | ${b.streamingFpsP95 >= b.streamingTargetFps ? "✅" : "❌"} |`);
    } else if (b.name === "native-benchmark") {
      lines.push(`| Native | Module loaded | ${b.nativeAvailable ? "yes" : "no (TS fallbacks)"} | — | ${b.passed ? "✅" : "❌"} |`);
      for (const r of b.rows) {
        lines.push(`| Native | ${r.path} | ${r.speedup.toFixed(1)}x (identical=${r.identical}) | identical | ${r.identical ? "✅" : "❌"} |`);
      }
    }
  }

  lines.push("", "## Targets", "", "- Cache hit rate: ≥80%", "- 1000-turn load: <2s", "- Streaming: ≥55fps (p95)", "- Native outputs byte-identical to TS fallbacks", "");
  return lines.join("\n");
}

const isMain = process.argv[1]?.endsWith("run-benchmarks.ts");

if (isMain) {
  const report = await runAllBenchmarks();
  console.log(JSON.stringify(report, null, 2));

  const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const docPath = join(root, "docs/PERFORMANCE_REPORT.md");
  writeFileSync(docPath, formatMarkdown(report), "utf8");
  console.error(`Wrote ${docPath}`);

  process.exit(report.allPassed ? 0 : 1);
}
