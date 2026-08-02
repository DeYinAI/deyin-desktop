import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computePrefixShape } from "../src/cache/prefix-tracker.js";
import { buildRoutingContext } from "../src/coordinator/planner-router.js";
import { Coordinator } from "../src/coordinator/index.js";
import { JobsManager } from "../src/jobs/manager.js";
import { runAgent } from "../src/loop.js";
import { invalidateCorruptedCacheStats } from "../src/migration/session-v2.js";
import { PermissionEngine } from "../src/permissions.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import { BUILTIN_SUBAGENTS } from "../src/capabilities/subagents.js";
import { createFleetTool } from "../src/tools/fleet.js";
import type { AgentMessage } from "../src/types.js";
import { startMockOpenAI, textResponse } from "./helpers/mock-openai.js";

test("edge: coordinator fallback on planner timeout preserves executor transcript", async () => {
  const executorMessages: AgentMessage[] = [{ role: "system", content: "exec" }];
  const coord = new Coordinator("planner", executorMessages);
  const server = await startMockOpenAI(() => textResponse("Recovered."));

  try {
    const result = await coord.run(
      {
        userMessage: "Complex refactor",
        routingContext: buildRoutingContext("Refactor auth across packages", { mode: "agent" }),
      },
      {
        executorTools: [],
        runPlanner: async () => ({ ok: false, plan: "", error: "timeout" }),
        runExecutor: async ({ executorMessages: msgs }) =>
          runAgent({
            apiBaseUrl: server.url,
            getToken: async () => "t",
            model: "m",
            messages: [...msgs],
            tools: createBuiltinRegistry(),
            permissions: new PermissionEngine({ skipAll: true }),
            resolvePermission: async () => "allow",
            cwd: process.cwd(),
          }),
      },
    );

    assert.equal(result.executorOnly, true);
    assert.ok(executorMessages.some((m) => m.role === "user" && m.content.includes("planner pass failed")));
  } finally {
    await server.close();
  }
});

test("edge: fleet partial failure does not abort successful siblings", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-edge-fleet-"));
  writeFileSync(join(cwd, "a.ts"), "a");
  writeFileSync(join(cwd, "b.ts"), "b");

  const fleet = createFleetTool({
    subagents: BUILTIN_SUBAGENTS,
    cwd,
    runSubagent: async (_d, p) =>
      p.includes("b.ts") ? { ok: false, report: "disk full" } : { ok: true, report: "ok" },
  });

  const out = await fleet.execute(
    {
      tasks: [
        { profile: "explorer", prompt: "a.ts", write_paths: ["a.ts"] },
        { profile: "explorer", prompt: "b.ts", write_paths: ["b.ts"] },
      ],
    },
    { cwd, todos: [] },
  );

  assert.ok(out.includes("status: completed"));
  assert.ok(out.includes("status: failed"));
  rmSync(cwd, { recursive: true, force: true });
});

test("edge: cache stats invalidated when prefix hash corrupted", () => {
  const system = { role: "system" as const, content: "test" };
  const tools = [{ type: "function" as const, function: { name: "read", description: "d", parameters: {} } }];
  const shape = computePrefixShape(system, tools, 0, 50);

  const reset = invalidateCorruptedCacheStats("deadbeefdeadbeef", shape.prefixHash, {
    sessionCacheHit: 9000,
    sessionCacheMiss: 1000,
    hitRate: 0.9,
    logRewriteVersion: 0,
    lastUpdated: new Date().toISOString(),
  });

  assert.ok(reset);
  assert.equal(reset!.sessionCacheHit, 0);
  assert.equal(reset!.hitRate, 0);
});

test("edge: background jobs recovered after crash on reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-edge-jobs-"));
  const persist = join(dir, "jobs.jsonl");

  writeFileSync(
    persist,
    `${JSON.stringify({
      id: "job-stale",
      sessionId: "sess-crash",
      kind: "task",
      label: "bg",
      prompt: "work",
      startTime: Date.now() - 120_000,
      status: "running",
    })}\n`,
  );

  const mgr = new JobsManager("sess-crash", persist);
  assert.equal(mgr.get("job-stale")?.status, "failed");

  rmSync(dir, { recursive: true, force: true });
});

test("edge: graceful degradation when planner throws unexpectedly", async () => {
  const coord = new Coordinator("p", [{ role: "system", content: "e" }]);
  const server = await startMockOpenAI(() => textResponse("Executor handled exception path."));

  try {
    const result = await coord.run(
      {
        userMessage: "Refactor everything",
        routingContext: buildRoutingContext("Refactor everything", { mode: "agent" }),
      },
      {
        executorTools: [],
        runPlanner: async () => {
          throw new Error("unexpected planner crash");
        },
        runExecutor: async ({ executorMessages: msgs }) =>
          runAgent({
            apiBaseUrl: server.url,
            getToken: async () => "t",
            model: "m",
            messages: [...msgs],
            tools: createBuiltinRegistry(),
            permissions: new PermissionEngine({ skipAll: true }),
            resolvePermission: async () => "allow",
            cwd: process.cwd(),
          }),
      },
    );

    assert.equal(result.executorOnly, true);
    assert.equal(result.finalText, "Executor handled exception path.");
  } finally {
    await server.close();
  }
});
