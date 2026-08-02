/**
 * Coordinator routing overhead benchmark.
 */

import { buildRoutingContext, routePlannerExecution } from "../../src/coordinator/planner-router.js";
import { Coordinator } from "../../src/coordinator/index.js";
import type { AgentMessage } from "../../src/types.js";

export interface CoordinatorBenchmarkResult {
  name: "coordinator-benchmark";
  iterations: number;
  avgRoutingUs: number;
  avgRunUs: number;
  overheadTargetUs: number;
  passed: boolean;
}

const SAMPLE_PROMPTS = [
  "fix typo in README.md",
  "Refactor auth across handler.ts and middleware.ts",
  "just plan the database migration",
  "Please plan first before changing the API",
  "update the login form styling",
  "refactor the entire payment module across packages",
];

export function runCoordinatorBenchmark(iterations = 5000): CoordinatorBenchmarkResult {
  let routingTotalUs = 0;
  let runTotalUs = 0;

  for (let i = 0; i < iterations; i++) {
    const prompt = SAMPLE_PROMPTS[i % SAMPLE_PROMPTS.length]!;
    const t0 = performance.now();
    const ctx = buildRoutingContext(prompt, { mode: "agent" });
    routePlannerExecution(ctx);
    routingTotalUs += (performance.now() - t0) * 1000;

    const t1 = performance.now();
    const coord = new Coordinator("planner", [{ role: "system", content: "exec" } as AgentMessage]);
    void coord.decidePlanning(ctx);
    runTotalUs += (performance.now() - t1) * 1000;
  }

  const avgRoutingUs = routingTotalUs / iterations;
  const avgRunUs = runTotalUs / iterations;
  const overheadTargetUs = 500;

  return {
    name: "coordinator-benchmark",
    iterations,
    avgRoutingUs,
    avgRunUs,
    overheadTargetUs,
    passed: avgRoutingUs < overheadTargetUs && avgRunUs < overheadTargetUs * 2,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runCoordinatorBenchmark();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
