import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildRoutingContext,
} from "../../src/coordinator/planner-router.js";
import { Coordinator } from "../../src/coordinator/index.js";
import { runAgent } from "../../src/loop.js";
import { PermissionEngine } from "../../src/permissions.js";
import { createBuiltinRegistry } from "../../src/tools/index.js";
import type { AgentMessage } from "../../src/types.js";
import { seedRefactorWorkspace, startMockOpenAI, textResponse, toolCallResponse } from "./helpers.js";

test("E2E: multi-file refactor routes plan_and_execute and completes handoff", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-coord-e2e-"));
  seedRefactorWorkspace(cwd);

  const executorMessages: AgentMessage[] = [
    { role: "system", content: "You are the Deyin executor." },
  ];

  const coord = new Coordinator("You are the Deyin planner.", executorMessages);
  const userTask = "Refactor auth across handler.ts, middleware.ts, and routes.ts";

  let plannerSteps = 0;
  let executorSteps = 0;
  const phases: string[] = [];

  const plannerServer = await startMockOpenAI((i) => {
    plannerSteps += 1;
    if (i === 0) {
      return toolCallResponse("p_read", "read", { path: "src/auth/handler.ts" });
    }
    return textResponse(
      "Plan:\n1. Update auth handler signature\n2. Adjust middleware\n3. Fix routes imports",
    );
  });

  const executorServer = await startMockOpenAI((i) => {
    executorSteps += 1;
    if (i === 0) {
      return toolCallResponse("e_edit", "edit", {
        path: "src/auth/handler.ts",
        old_string: "return true",
        new_string: "return validate(token)",
      });
    }
    if (i === 1) {
      return toolCallResponse("e_edit2", "edit", {
        path: "src/api/routes.ts",
        old_string: "import { auth }",
        new_string: "import { auth, validate }",
      });
    }
    return textResponse("Refactor complete across auth modules.");
  });

  try {
    const result = await coord.run(
      {
        userMessage: userTask,
        routingContext: buildRoutingContext(userTask, { mode: "agent" }),
      },
      {
        executorTools: [],
        onPhase: (e) => phases.push(e.phase),
        runPlanner: async ({ plannerMessages, maxSteps }) => {
          const msgs = [...plannerMessages];
          const run = await runAgent({
            apiBaseUrl: plannerServer.url,
            getToken: async () => "token",
            model: "planner",
            messages: msgs,
            tools: createBuiltinRegistry(),
            permissions: new PermissionEngine({ skipAll: true }),
            resolvePermission: async () => "allow",
            cwd,
            maxSteps,
          });
          return { ok: true, plan: run.finalText };
        },
        runExecutor: async ({ executorMessages: execMsgs }) => {
          const msgs = [...execMsgs];
          const run = await runAgent({
            apiBaseUrl: executorServer.url,
            getToken: async () => "token",
            model: "executor",
            messages: msgs,
            tools: createBuiltinRegistry(),
            permissions: new PermissionEngine({ skipAll: true }),
            resolvePermission: async () => "allow",
            cwd,
            maxSteps: 5,
          });
          return run;
        },
      },
    );

    assert.equal(result.decision.route, "plan_and_execute");
    assert.equal(result.plannerUsed, true);
    assert.equal(result.executorOnly, false);
    assert.ok(result.finalText.includes("Refactor complete"));
    assert.ok(phases.includes("planning"));
    assert.ok(phases.includes("executing"));
    assert.ok(plannerSteps >= 1);
    assert.ok(executorSteps >= 1);

    // Sessions stay isolated: planner transcript ≠ executor transcript.
    const plannerSession = coord.getPlannerSession();
    const execSession = coord.getExecutorSession();
    assert.ok(plannerSession.some((m) => m.role === "assistant" && m.content.includes("Plan")));
    assert.ok(execSession.some((m) => m.role === "user" && m.content.includes("handoff")));
    assert.ok(!plannerSession.some((m) => m.content.includes("Refactor complete across")));
  } finally {
    await plannerServer.close();
    await executorServer.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E2E: coordinator falls back to executor-only on planner timeout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-coord-fallback-"));
  const executorMessages: AgentMessage[] = [{ role: "system", content: "executor" }];
  const coord = new Coordinator("planner", executorMessages);

  const executorServer = await startMockOpenAI(() => textResponse("Handled without planner."));

  try {
    const result = await coord.run(
      {
        userMessage: "Refactor auth across the codebase",
        routingContext: buildRoutingContext("Refactor auth across the codebase", { mode: "agent" }),
      },
      {
        executorTools: [],
        runPlanner: async () => ({ ok: false, plan: "", error: "timeout" }),
        runExecutor: async ({ executorMessages: msgs }) =>
          runAgent({
            apiBaseUrl: executorServer.url,
            getToken: async () => "token",
            model: "executor",
            messages: [...msgs],
            tools: createBuiltinRegistry(),
            permissions: new PermissionEngine({ skipAll: true }),
            resolvePermission: async () => "allow",
            cwd,
          }),
      },
    );

    assert.equal(result.executorOnly, true);
    assert.equal(result.finalText, "Handled without planner.");
  } finally {
    await executorServer.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
