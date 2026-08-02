import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN_SUBAGENTS } from "../../src/capabilities/subagents.js";
import { runAgent } from "../../src/loop.js";
import { PermissionEngine } from "../../src/permissions.js";
import { createBuiltinRegistry } from "../../src/tools/index.js";
import { createFleetTool } from "../../src/tools/fleet.js";
import type { AgentMessage } from "../../src/types.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "./helpers.js";

test("E2E: fleet parallel edits on non-overlapping paths via agent turn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-fleet-e2e-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, "src", "b.ts"), "export const b = 2;\n");

  let parallel = 0;
  let maxParallel = 0;

  const fleetTool = createFleetTool({
    subagents: BUILTIN_SUBAGENTS,
    cwd,
    runSubagent: async (_def, prompt) => {
      parallel++;
      maxParallel = Math.max(maxParallel, parallel);
      await new Promise((r) => setTimeout(r, 30));
      const pathMatch = prompt.match(/src\/[ab]\.ts/);
      if (pathMatch) {
        writeFileSync(join(cwd, pathMatch[0]), `// updated ${pathMatch[0]}\n`);
      }
      parallel--;
      return { ok: true, report: `Updated ${pathMatch?.[0] ?? "unknown"}` };
    },
  });

  const registry = createBuiltinRegistry();
  registry.register(fleetTool);

  const messages: AgentMessage[] = [
    { role: "system", content: "Use fleet for parallel edits." },
    { role: "user", content: "Update src/a.ts and src/b.ts in parallel" },
  ];

  const server = await startMockOpenAI((i) => {
    if (i === 0) {
      return toolCallResponse("fleet_1", "fleet", {
        tasks: [
          { profile: "explorer", prompt: "edit src/a.ts", write_paths: ["src/a.ts"] },
          { profile: "explorer", prompt: "edit src/b.ts", write_paths: ["src/b.ts"] },
        ],
      });
    }
    return textResponse("Both components updated in parallel.");
  });

  try {
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "token",
      model: "test",
      messages,
      tools: registry,
      permissions: new PermissionEngine({ skipAll: true }),
      resolvePermission: async () => "allow",
      cwd,
    });

    assert.equal(result.reason, "completed");
    assert.ok(maxParallel >= 2, `expected parallel execution, got maxParallel=${maxParallel}`);
    assert.ok(readFileSync(join(cwd, "src/a.ts"), "utf8").includes("updated"));
    assert.ok(readFileSync(join(cwd, "src/b.ts"), "utf8").includes("updated"));

    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg && toolMsg.role === "tool" && toolMsg.content.includes("Completed fleet"));
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E2E: fleet partial failure rolls back remaining tasks gracefully", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-fleet-partial-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "ok.ts"), "ok\n");
  writeFileSync(join(cwd, "src", "fail.ts"), "fail\n");

  const fleetTool = createFleetTool({
    subagents: BUILTIN_SUBAGENTS,
    cwd,
    runSubagent: async (_def, prompt) => {
      if (prompt.includes("fail.ts")) {
        return { ok: false, report: "simulated write failure" };
      }
      writeFileSync(join(cwd, "src/ok.ts"), "updated ok\n");
      return { ok: true, report: "ok.ts updated" };
    },
  });

  const registry = createBuiltinRegistry();
  registry.register(fleetTool);

  const result = await fleetTool.execute(
    {
      tasks: [
        { profile: "explorer", prompt: "edit src/ok.ts", write_paths: ["src/ok.ts"] },
        { profile: "explorer", prompt: "edit src/fail.ts", write_paths: ["src/fail.ts"] },
      ],
    },
    { cwd, todos: [] },
  );

  assert.ok(result.includes("Completed fleet"));
  assert.ok(result.includes("status: completed"));
  assert.ok(result.includes("status: failed"));
  assert.equal(readFileSync(join(cwd, "src/ok.ts"), "utf8"), "updated ok\n");
  assert.equal(readFileSync(join(cwd, "src/fail.ts"), "utf8"), "fail\n");

  rmSync(cwd, { recursive: true, force: true });
});
