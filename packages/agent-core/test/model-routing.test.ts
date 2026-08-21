import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent, type AgentEvent } from "../src/loop.js";
import {
  createRoleRouter,
  parseModelRef,
  roleForMode,
  roleForStep,
  type RouterBase,
} from "../src/model-routing.js";
import { PermissionEngine } from "../src/permissions.js";
import { createBuiltinRegistry } from "../src/tools/index.js";
import type { AgentMessage } from "../src/types.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "./helpers/mock-openai.js";

/* parseModelRef ------------------------------------------------------------ */

test("parseModelRef splits provider::model and tolerates junk", () => {
  assert.deepEqual(parseModelRef("openference::GLM-5.2"), { providerId: "openference", model: "GLM-5.2" });
  // A bare id keeps the run's own provider.
  assert.deepEqual(parseModelRef("GLM-5.2"), { model: "GLM-5.2" });
  assert.deepEqual(parseModelRef("  ollama::qwen  "), { providerId: "ollama", model: "qwen" });
  assert.equal(parseModelRef("openference::"), undefined);
  assert.equal(parseModelRef("   "), undefined);
  assert.equal(parseModelRef(undefined), undefined);
  assert.equal(parseModelRef(null), undefined);
});

/* role selection ----------------------------------------------------------- */

test("roleForMode maps composer modes, defaulting unknown modes to implement", () => {
  assert.equal(roleForMode("plan"), "plan");
  assert.equal(roleForMode("ask"), "ask");
  assert.equal(roleForMode("delivery"), "delivery");
  assert.equal(roleForMode("agent"), "implement");
  assert.equal(roleForMode(undefined), "implement");
  assert.equal(roleForMode("something-else"), "implement");
});

test("roleForStep routes read-only churn to the tool role", () => {
  const churn = { hadProse: false, toolNames: ["read", "grep"], allRead: true };

  // Step 1 always belongs to the mode: there is no previous step to classify.
  assert.equal(roleForStep({ step: 1, mode: "agent", previous: churn }), "implement");
  assert.equal(roleForStep({ step: 2, mode: "agent", previous: churn }), "tool");
  // Cheap churn applies inside read-only modes too.
  assert.equal(roleForStep({ step: 3, mode: "plan", previous: churn }), "tool");
});

test("roleForStep keeps the mode's model when the step was not pure churn", () => {
  const mode = "agent";
  // Prose means the model was reasoning, not grinding.
  assert.equal(roleForStep({ step: 2, mode, previous: { hadProse: true, toolNames: ["read"], allRead: true } }), "implement");
  // A mutation must hand back to the real model.
  assert.equal(roleForStep({ step: 2, mode, previous: { hadProse: false, toolNames: ["edit"], allRead: false } }), "implement");
  // Mixed read + write is not read-only churn.
  assert.equal(
    roleForStep({ step: 2, mode, previous: { hadProse: false, toolNames: ["read", "bash"], allRead: false } }),
    "implement",
  );
  // No tools at all.
  assert.equal(roleForStep({ step: 2, mode, previous: { hadProse: false, toolNames: [], allRead: true } }), "implement");
  assert.equal(roleForStep({ step: 2, mode }), "implement");
});

/* createRoleRouter --------------------------------------------------------- */

const base: RouterBase = {
  model: "base-model",
  providerId: "openference",
  apiBaseUrl: "https://base.example",
  getToken: async () => "base-token",
  contextLength: 128_000,
};

test("createRoleRouter returns undefined when nothing is overridden", () => {
  assert.equal(createRoleRouter({ roleModels: {}, base }), undefined);
  // Unknown roles and unusable refs do not count as overrides.
  assert.equal(createRoleRouter({ roleModels: { coordinator: "x::y", plan: "  " }, base }), undefined);
});

test("createRoleRouter falls back to the run's model for unset roles", () => {
  const router = createRoleRouter({ roleModels: { plan: "big-model" }, base })!;
  const plan = router({ step: 1, mode: "plan" });
  assert.equal(plan.model, "big-model");
  assert.equal(plan.role, "plan");
  // Bare ref keeps the base provider and endpoint.
  assert.equal(plan.providerId, "openference");
  assert.equal(plan.apiBaseUrl, "https://base.example");

  const implement = router({ step: 1, mode: "agent" });
  assert.equal(implement.model, "base-model");
  assert.equal(implement.role, "implement");
});

test("createRoleRouter routes a cross-provider role to that provider's endpoint", () => {
  const router = createRoleRouter({
    roleModels: { tool: "ollama::qwen" },
    base,
    resolveProvider: (id) =>
      id === "ollama"
        ? { apiBaseUrl: "http://localhost:11434/v1", getToken: async () => "", apiFormat: "chat-completions" }
        : undefined,
    getContextLength: (providerId, model) => (providerId === "ollama" && model === "qwen" ? 32_000 : undefined),
  })!;

  const routing = router({ step: 2, mode: "agent", previous: { hadProse: false, toolNames: ["read"], allRead: true } });
  assert.equal(routing.role, "tool");
  assert.equal(routing.model, "qwen");
  assert.equal(routing.providerId, "ollama");
  assert.equal(routing.apiBaseUrl, "http://localhost:11434/v1");
  assert.equal(routing.contextLength, 32_000);
});

test("createRoleRouter keeps the base endpoint when a provider cannot be resolved", () => {
  const router = createRoleRouter({ roleModels: { plan: "missing-provider::m" }, base })!;
  const routing = router({ step: 1, mode: "plan" });
  assert.equal(routing.model, "m");
  // Model still swaps; the endpoint degrades to the run's own rather than failing.
  assert.equal(routing.apiBaseUrl, "https://base.example");
});

/* loop integration --------------------------------------------------------- */

test("runAgent asks the router per step and switches model mid-run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-routing-"));
  writeFileSync(join(cwd, "a.txt"), "alpha");
  writeFileSync(join(cwd, "b.txt"), "beta");

  // step 1: read (no prose) -> step 2 is read-only churn -> tool model
  // step 2: read (no prose) -> step 3 is churn too
  // step 3: final answer
  const server = await startMockOpenAI((i) => {
    if (i === 0) return toolCallResponse("c1", "read", { path: "a.txt" });
    if (i === 1) return toolCallResponse("c2", "read", { path: "b.txt" });
    return textResponse("alpha and beta.");
  });

  try {
    const messages: AgentMessage[] = [
      { role: "system", content: "test agent" },
      { role: "user", content: "read both files" },
    ];
    const events: AgentEvent[] = [];
    const result = await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "base-token",
      model: "implement-model",
      messages,
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "deny",
      cwd,
      toolContext: { sessionMeta: { mode: "agent" } },
      router: createRoleRouter({
        roleModels: { tool: "cheap-model" },
        base: {
          model: "implement-model",
          providerId: "openference",
          apiBaseUrl: server.url,
          getToken: async () => "base-token",
        },
      }),
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.reason, "completed");
    assert.deepEqual(
      server.requests.map((r) => r.model),
      ["implement-model", "cheap-model", "cheap-model"],
    );

    // One event per actual change of model, not one per step.
    const routed = events.filter((e): e is Extract<AgentEvent, { type: "model-routed" }> => e.type === "model-routed");
    assert.deepEqual(
      routed.map((e) => [e.step, e.role, e.model]),
      [
        [1, "implement", "implement-model"],
        [2, "tool", "cheap-model"],
      ],
    );
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runAgent without a router keeps the single-model path untouched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-routing-"));
  writeFileSync(join(cwd, "a.txt"), "alpha");
  const server = await startMockOpenAI((i) =>
    i === 0 ? toolCallResponse("c1", "read", { path: "a.txt" }) : textResponse("done"),
  );

  try {
    const events: AgentEvent[] = [];
    await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "t",
      model: "only-model",
      messages: [
        { role: "system", content: "test agent" },
        { role: "user", content: "read a.txt" },
      ],
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "deny",
      cwd,
      onEvent: (event) => events.push(event),
    });

    assert.deepEqual(server.requests.map((r) => r.model), ["only-model", "only-model"]);
    assert.equal(events.some((e) => e.type === "model-routed"), false);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("mid-run mode switch re-routes the next step's model", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "deyin-routing-"));
  const server = await startMockOpenAI((i) =>
    i === 0
      ? toolCallResponse("c1", "switch_mode", { target_mode_id: "plan", explanation: "need a plan" })
      : textResponse("here is the plan"),
  );

  try {
    const sessionMeta: { mode?: string } = { mode: "agent" };
    await runAgent({
      apiBaseUrl: server.url,
      getToken: async () => "t",
      model: "implement-model",
      messages: [
        { role: "system", content: "test agent" },
        { role: "user", content: "plan this" },
      ],
      tools: createBuiltinRegistry(),
      permissions: new PermissionEngine(),
      resolvePermission: async () => "allow",
      cwd,
      toolContext: {
        sessionMeta,
        onModeChange: async (change) => {
          sessionMeta.mode = change.target;
          return `Switched to ${change.target} mode.`;
        },
      },
      router: createRoleRouter({
        roleModels: { plan: "planner-model" },
        base: { model: "implement-model", providerId: "openference", apiBaseUrl: server.url, getToken: async () => "t" },
      }),
    });

    // Step 2 runs after switch_mode flipped sessionMeta.mode to "plan".
    assert.deepEqual(server.requests.map((r) => r.model), ["implement-model", "planner-model"]);
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
