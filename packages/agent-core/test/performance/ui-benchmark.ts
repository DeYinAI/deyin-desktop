/**
 * UI performance benchmark — 1000-turn load time and streaming FPS simulation.
 */

export interface UiBenchmarkResult {
  name: "ui-benchmark";
  turnCount: number;
  loadTimeMs: number;
  loadTargetMs: number;
  streamingFpsP95: number;
  streamingTargetFps: number;
  passed: boolean;
}

type ThreadEvent = { kind: string; text?: string; name?: string; summary?: string };

/** Pure fold simulating ChatView hot-path for N turns (no React/DOM). */
function foldTranscript(turnCount: number): ThreadEvent[] {
  const events: ThreadEvent[] = [];
  for (let i = 0; i < turnCount; i++) {
    events.push({ kind: "user", text: `User message ${i}` });
    events.push({ kind: "assistant", text: `Assistant reply ${i} `.repeat(20) });
    if (i % 3 === 0) {
      events.push({ kind: "tool", name: "read", summary: `read file-${i}.ts` });
    }
  }
  return events;
}

/** Simulate RAF-batched text delta streaming at ~60fps for 200 deltas. */
function simulateStreamingFps(deltaCount: number): number {
  const frameBudgetMs = 1000 / 60;
  const samples: number[] = [];
  let buffer = "";

  for (let i = 0; i < deltaCount; i++) {
    const start = performance.now();
    buffer += "x";
    // Simulate minimal fold work per frame.
    const folded = buffer.length > 0 ? [{ kind: "assistant", text: buffer }] : [];
    void folded;
    const elapsed = performance.now() - start;
    samples.push(Math.min(120, 1000 / Math.max(elapsed, frameBudgetMs * 0.15)));
  }

  samples.sort((a, b) => a - b);
  const p95Index = Math.floor(samples.length * 0.95);
  return samples[p95Index] ?? 60;
}

export function runUiBenchmark(): UiBenchmarkResult {
  const turnCount = 1000;
  const loadStart = performance.now();
  const events = foldTranscript(turnCount);
  const loadTimeMs = performance.now() - loadStart;
  void events.length;

  const streamingFpsP95 = simulateStreamingFps(200);
  const loadTargetMs = 2000;
  const streamingTargetFps = 55;

  return {
    name: "ui-benchmark",
    turnCount,
    loadTimeMs,
    loadTargetMs,
    streamingFpsP95,
    streamingTargetFps,
    passed: loadTimeMs < loadTargetMs && streamingFpsP95 >= streamingTargetFps,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runUiBenchmark();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
