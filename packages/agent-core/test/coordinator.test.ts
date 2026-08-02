import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRoutingContext,
  routePlannerExecution,
} from "../src/coordinator/planner-router.js";
import {
  Coordinator,
  formatHandoff,
  handoffTask,
  isNoOpPlan,
} from "../src/coordinator/index.js";
import type { AgentMessage } from "../src/types.js";

test("routing: plan mode → executor_only", () => {
  const ctx = buildRoutingContext("refactor the entire codebase", { mode: "plan" });
  const d = routePlannerExecution(ctx);
  assert.equal(d.route, "executor_only");
  assert.equal(d.reason, "explicit_plan_mode");
});

test("routing: plan first → plan_for_approval", () => {
  const ctx = buildRoutingContext("Please plan first before changing auth", { mode: "agent" });
  const d = routePlannerExecution(ctx);
  assert.equal(d.route, "plan_for_approval");
});

test("routing: just plan → plan_only", () => {
  const ctx = buildRoutingContext("just plan how we would migrate the database", { mode: "agent" });
  const d = routePlannerExecution(ctx);
  assert.equal(d.route, "plan_only");
});

test("routing: multi-file refactor → plan_and_execute", () => {
  const ctx = buildRoutingContext("Refactor auth across the codebase", { mode: "agent" });
  const d = routePlannerExecution(ctx);
  assert.equal(d.route, "plan_and_execute");
});

test("routing: simple fix typo → executor_only", () => {
  const ctx = buildRoutingContext("fix typo in README.md", { mode: "agent" });
  const d = routePlannerExecution(ctx);
  assert.equal(d.route, "executor_only");
});

test("handoff format includes original task and planner output", () => {
  const msg = formatHandoff("do the thing", "Step 1: read file\nStep 2: edit", "- tools attached");
  assert.ok(msg.includes("Original task:\ndo the thing"));
  assert.ok(msg.includes("Planner output:\nStep 1"));
  assert.ok(msg.includes("Executor tool context"));
  assert.equal(handoffTask(msg), "do the thing");
});

test("isNoOpPlan detects no-change plans", () => {
  assert.equal(isNoOpPlan("No changes needed — already implemented."), true);
  assert.equal(isNoOpPlan("Please add tests and update docs."), false);
});

test("coordinator keeps planner and executor sessions isolated", async () => {
  const coord = new Coordinator("planner system", [{ role: "system", content: "executor system" }]);

  let plannerRan = false;
  let executorRan = false;

  await coord.run(
    {
      userMessage: "Refactor auth across multiple packages",
      routingContext: buildRoutingContext("Refactor auth across multiple packages", { mode: "agent" }),
    },
    {
      executorTools: [],
      runPlanner: async ({ plannerMessages }) => {
        plannerRan = true;
        assert.ok(plannerMessages.every((m) => m.content !== "executor system" || m.role === "system"));
        return { ok: true, plan: "1. Read auth module\n2. Update handlers" };
      },
      runExecutor: async ({ executorMessages }) => {
        executorRan = true;
        assert.ok(executorMessages.some((m) => m.role === "user" && m.content.includes("Deyin executor handoff")));
        return { reason: "completed", finalText: "Done.", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, steps: 1 };
      },
    },
  );

  assert.equal(plannerRan, true);
  assert.equal(executorRan, true);
  assert.equal(coord.getPlannerSession().length, 3); // system, user, assistant
  assert.ok(coord.getExecutorSession().length >= 3);
});

test("coordinator falls back to executor on planner failure", async () => {
  const coord = new Coordinator("planner", [{ role: "system", content: "exec" }]);
  const result = await coord.run(
    {
      userMessage: "Complex task",
      routingContext: buildRoutingContext("Refactor everything", { mode: "agent" }),
    },
    {
      executorTools: [],
      runPlanner: async () => ({ ok: false, plan: "", error: "timeout" }),
      runExecutor: async () => ({
        reason: "completed",
        finalText: "Handled directly.",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        steps: 1,
      }),
    },
  );

  assert.equal(result.executorOnly, true);
  assert.equal(result.finalText, "Handled directly.");
});

test("coordinator plan_only persists without executing", async () => {
  const coord = new Coordinator("planner", [{ role: "system", content: "exec" }]);
  let executorRan = false;

  const result = await coord.run(
    {
      userMessage: "just plan the migration",
      routingContext: buildRoutingContext("just plan the migration", { mode: "agent" }),
    },
    {
      executorTools: [],
      runPlanner: async () => ({ ok: true, plan: "Migration plan step 1..." }),
      runExecutor: async () => {
        executorRan = true;
        return { reason: "completed", finalText: "x", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, steps: 1 };
      },
    },
  );

  assert.equal(executorRan, false);
  assert.equal(result.finalText, "Migration plan step 1...");
  const exec = coord.getExecutorSession();
  const assistant = exec.find((m) => m.role === "assistant") as AgentMessage | undefined;
  assert.ok(assistant && assistant.role === "assistant");
});
