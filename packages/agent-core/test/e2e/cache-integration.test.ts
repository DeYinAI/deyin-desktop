import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OptimizationTracker } from "../../src/optimization.js";
import { comparePrefixShapes, computePrefixShape } from "../../src/cache/prefix-tracker.js";
import { runAgent } from "../../src/loop.js";
import { PermissionEngine } from "../../src/permissions.js";
import { createBuiltinRegistry } from "../../src/tools/index.js";
import type { AgentMessage } from "../../src/types.js";
import { SESSION_HIT_RATE_TARGET } from "../../src/testing/cache-guard.js";
import { startMockOpenAI, textResponseWithCache, toolCallResponse } from "./helpers.js";

test("E2E: cache hit rate accumulates across multi-turn agent session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-cache-e2e-"));
  writeFileSync(join(cwd, "data.txt"), "line1\nline2\n");

  const messages: AgentMessage[] = [
    { role: "system", content: "Stable system prompt for cache test." },
    { role: "user", content: "Read data.txt repeatedly" },
  ];

  let turn = 0;
  const server = await startMockOpenAI((i) => {
    turn += 1;
    if (i % 2 === 0) {
      return toolCallResponse(`read_${i}`, "read", { path: "data.txt" });
    }
    // Simulate increasing cache hits on later turns (≥85% aggregate).
    const hitTokens = Math.min(12000, 4000 + turn * 600);
    const missTokens = Math.max(200, 800 - turn * 100);
    return textResponseWithCache(`Turn ${turn} complete.`, hitTokens, missTokens);
  });

  const tracker = new OptimizationTracker();

  try {
    await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
      maxSteps: 6,
      onEvent: (e) => {
        if (e.type === "optimization") {
          const shape = e.metrics.prefixShape;
          const diag = e.metrics.cacheDiagnostics;
          if (shape && diag) tracker.recordPrefixShape(shape, diag);
        }
      },
    });

    const metrics = tracker.get();
    const total = metrics.sessionCacheHit + metrics.sessionCacheMiss;
    const hitRate = total === 0 ? 1 : metrics.sessionCacheHit / total;
    assert.ok(hitRate >= SESSION_HIT_RATE_TARGET, `hit rate ${hitRate} below ${SESSION_HIT_RATE_TARGET}`);
    assert.ok(metrics.sessionCacheHit > 0);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E2E: prefix shape stable across coordinator-style isolated sessions", () => {
  const system = { role: "system" as const, content: "Executor system — stable." };
  const tools = Array.from({ length: 12 }, (_, j) => ({
    type: "function" as const,
    function: { name: `tool_${j}`, description: "d", parameters: { type: "object", properties: {} } },
  }));

  let prev = computePrefixShape(system, tools, 0, 600);
  let invalidations = 0;

  for (let turn = 1; turn <= 20; turn++) {
    const shape = computePrefixShape(system, tools, 0, 600);
    const diag = comparePrefixShapes(prev, shape, 7200, 800);
    if (diag.prefixChanged) invalidations += 1;
    prev = shape;
  }

  assert.equal(invalidations, 0);
});
