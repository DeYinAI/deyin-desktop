/**
 * Fleet parallel execution speedup benchmark.
 */

import { BUILTIN_SUBAGENTS } from "../../src/capabilities/subagents.js";
import { createFleetTool } from "../../src/tools/fleet.js";

export interface FleetBenchmarkResult {
  name: "fleet-benchmark";
  taskCount: number;
  serialMs: number;
  parallelMs: number;
  speedup: number;
  speedupTargetMin: number;
  speedupTargetMax: number;
  passed: boolean;
}

const TASK_MS = 25;

export async function runFleetBenchmark(taskCount = 8): Promise<FleetBenchmarkResult> {
  const cwd = process.cwd();

  const serialStart = performance.now();
  for (let i = 0; i < taskCount; i++) {
    await new Promise((r) => setTimeout(r, TASK_MS));
  }
  const serialMs = performance.now() - serialStart;

  let parallel = 0;
  const fleet = createFleetTool({
    subagents: BUILTIN_SUBAGENTS,
    cwd,
    runSubagent: async () => {
      parallel++;
      await new Promise((r) => setTimeout(r, TASK_MS));
      parallel--;
      return { ok: true, report: "ok" };
    },
  });

  const parallelStart = performance.now();
  await fleet.execute(
    {
      tasks: Array.from({ length: taskCount }, (_, i) => ({
        profile: "explorer",
        prompt: `task ${i}`,
        read_only: true,
      })),
    },
    { cwd, todos: [] },
  );
  const parallelMs = performance.now() - parallelStart;

  const speedup = serialMs / Math.max(parallelMs, 1);
  const speedupTargetMin = 2;
  const speedupTargetMax = 8;

  return {
    name: "fleet-benchmark",
    taskCount,
    serialMs,
    parallelMs,
    speedup,
    speedupTargetMin,
    speedupTargetMax,
    passed: speedup >= speedupTargetMin,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runFleetBenchmark();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
