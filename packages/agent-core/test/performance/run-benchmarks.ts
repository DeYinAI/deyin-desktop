/**
 * Run all agent performance benchmarks and emit a combined report.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCacheBenchmark } from "./cache-benchmark.js";
import { runCompactionBenchmark } from "./compaction-bench.js";
import { runNativeBenchmark } from "./native-benchmark.js";
import { runSummaryBenchmark } from "./summary-benchmark.js";
import { runUiBenchmark } from "./ui-benchmark.js";

export interface PerformanceReport {
  generatedAt: string;
  allPassed: boolean;
  benchmarks: Array<
    | ReturnType<typeof runCacheBenchmark>
    | ReturnType<typeof runUiBenchmark>
    | ReturnType<typeof runNativeBenchmark>
    | Awaited<ReturnType<typeof runSummaryBenchmark>>
    | Awaited<ReturnType<typeof runCompactionBenchmark>>
  >;
}

export async function runAllBenchmarks(): Promise<PerformanceReport> {
  const cache = runCacheBenchmark();
  const ui = runUiBenchmark();
  const native = runNativeBenchmark();
  const summary = await runSummaryBenchmark();
  const compaction = await runCompactionBenchmark();

  const benchmarks = [cache, ui, native, summary, compaction];
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
    } else if (b.name === "summary-benchmark") {
      lines.push(`| Summary | Deterministic scenario | ${b.rows.map((r) => `${r.metric}=${r.actual}`).join(", ")} | ${b.rows.map((r) => `${r.metric}=${r.expected}`).join(", ")} | ${b.passed ? "✅" : "❌"} |`);
    } else if (b.name === "compaction-benchmark") {
      for (const r of b.cost.rows) {
        lines.push(`| Compaction | ${r.scenario} (window ${r.window}) | action=${r.action}, prune reclaimed ${r.pruneReclaimed} tok, second pass ${r.secondPassReclaimed} | action=${r.expected}, second pass 0 | ${r.ok ? "✅" : "❌"} |`);
      }
      lines.push(`| Compaction | Tail budget scaling | min(16k, 25% of window) | 32k→8k, 128k→16k | ${b.cost.tailBudgetsOk ? "✅" : "❌"} |`);
      lines.push(`| Compaction | Fold fidelity | ${b.fidelity.survived}/${b.fidelity.planted} facts survived | ${b.fidelity.expectedSurvivors} (tail immune, pinned intact, cache-shaped request) | ${b.passed ? "✅" : "❌"} |`);
    }
  }

  lines.push("", "## Targets", "", "- Cache hit rate: ≥80%", "- 1000-turn load: <2s", "- Streaming: ≥55fps (p95)", "- Native outputs byte-identical to TS fallbacks", "- Compaction: policy picks the expected action per scenario, prune is idempotent, folds preserve everything the summarizer returned", "");
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
