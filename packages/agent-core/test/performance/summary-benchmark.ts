/**
 * Deterministic end-to-end scenario that pins the RunSummary metrics through
 * the full runAgent loop: a successful read, a byte-identical duplicate read
 * (dedup), a three-times failing read (storm guard), and a denied bash call.
 * Unlike a real workload it never varies, so the summary numbers are a
 * regression baseline: any drift means a counter, the deduper, or a guard
 * changed behavior.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, type RunSummary } from "../../src/loop.js";
import { PermissionEngine } from "../../src/permissions.js";
import { createBuiltinRegistry } from "../../src/tools/index.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "../helpers/mock-openai.js";

export interface SummaryBenchmarkResult {
  name: "summary-benchmark";
  passed: boolean;
  summary: RunSummary;
  rows: Array<{ metric: keyof RunSummary; expected: number; actual: number; ok: boolean }>;
}

const EXPECTED: Partial<Record<keyof RunSummary, number>> = {
  toolCalls: 6,
  deniedCalls: 1,
  failedCalls: 3,
  duplicateResults: 1,
  loopGuardTrips: 1,
};

export async function runSummaryBenchmark(): Promise<SummaryBenchmarkResult> {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-summary-bench-"));
  // >512 chars so the deduper treats the second read as a full-cost duplicate.
  writeFileSync(join(cwd, "big.txt"), `${"The quick brown fox jumps over the lazy dog. ".repeat(20)}\n`);
  const server = await startMockOpenAI((i) => {
    if (i === 0) return toolCallResponse("call_read1", "read", { path: "big.txt" });
    if (i === 1) return toolCallResponse("call_read2", "read", { path: "big.txt" });
    if (i >= 2 && i <= 4) return toolCallResponse(`call_fail${i}`, "read", { path: "missing.txt" });
    if (i === 5) return toolCallResponse("call_deny", "bash", { command: "echo hi" });
    return textResponse("Done.");
  });
  try {
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "bench-token",
      model: "test-model",
      messages: [
        { role: "system", content: "You are a benchmark agent." },
        { role: "user", content: "exercise the run metrics" },
      ],
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async (req) => (req.toolName === "bash" ? "deny" : "allow"),
      cwd,
      maxSteps: 20,
    });
    const summary = result.summary;
    const rows = (Object.keys(EXPECTED) as Array<keyof RunSummary>).map((metric) => {
      const expected = EXPECTED[metric]!;
      const actual = Number(summary?.[metric] ?? -1);
      return { metric, expected, actual, ok: actual === expected };
    });
    return {
      name: "summary-benchmark",
      passed: rows.every((r) => r.ok),
      summary: summary ?? ({} as RunSummary),
      rows,
    };
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}
