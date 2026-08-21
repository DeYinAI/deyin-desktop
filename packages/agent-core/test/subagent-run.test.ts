import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionEngine } from "../src/permissions.js";
import {
  READONLY_RULES,
  agentForMode,
  resolveSubagentModel,
  rulesForApprovalMode,
  skipPromptsForApproval,
  subagentReadonlyRules,
} from "../src/subagent-run.js";

const PARENT = { model: "parent-model", providerId: "openference" };

test("resolveSubagentModel inherits parent model and provider by default", () => {
  const r = resolveSubagentModel({ model: undefined }, PARENT);
  assert.deepEqual(r, { model: "parent-model", providerId: "openference" });
});

test("resolveSubagentModel prefers frontmatter model but keeps the parent provider", () => {
  const r = resolveSubagentModel({ model: "deepseek-pro" }, PARENT);
  assert.deepEqual(r, { model: "deepseek-pro", providerId: "openference" });
});

test("resolveSubagentModel splits providerId::modelId overrides and routes the provider", () => {
  const r = resolveSubagentModel({ model: undefined }, PARENT, "custom-llm::glm-5.2");
  assert.deepEqual(r, { model: "glm-5.2", providerId: "custom-llm" });
});

test("resolveSubagentModel treats a bare override as an Openference model", () => {
  const r = resolveSubagentModel({ model: undefined }, PARENT, "glm-5.2");
  assert.deepEqual(r, { model: "glm-5.2", providerId: "openference" });
});

test("subagentReadonlyRules denies write/edit and asks bash only for readonly agents", () => {
  assert.deepEqual(subagentReadonlyRules({ readonly: true }), [
    { tool: "write", action: "deny" },
    { tool: "edit", action: "deny" },
    { tool: "bash", action: "ask" },
  ]);
  assert.deepEqual(subagentReadonlyRules({ readonly: false }), []);
});

test("rulesForApprovalMode grants READONLY_RULES only in read-only mode", () => {
  assert.deepEqual(rulesForApprovalMode("full-access"), []);
  assert.deepEqual(rulesForApprovalMode("ask-first"), []);
  assert.equal(rulesForApprovalMode("read-only"), READONLY_RULES);
  assert.ok(READONLY_RULES.some((r) => r.tool === "*" && r.action === "deny"));
});

test("agentForMode maps composer modes to built-in agents", () => {
  assert.equal(agentForMode("plan").name, "plan");
  assert.equal(agentForMode("ask").name, "ask");
  assert.equal(agentForMode("agent").name, "build");
});

test("plan mode denies bash so it stays read-only even under full access", () => {
  const plan = agentForMode("plan");
  const bashRule = plan.permissions?.find((r) => r.tool === "bash");
  assert.equal(bashRule?.action, "deny");
  for (const tool of ["write", "edit", "delete", "notebook_edit"]) {
    assert.equal(plan.permissions?.find((r) => r.tool === tool)?.action, "deny");
  }
});

test("full access never prompts in build-style modes", () => {
  assert.equal(skipPromptsForApproval("full-access", "agent"), true);
  assert.equal(skipPromptsForApproval("full-access", "delivery"), true);
});

test("full access still leaves plan/ask prompting for tools their rules miss", () => {
  assert.equal(skipPromptsForApproval("full-access", "plan"), false);
  assert.equal(skipPromptsForApproval("full-access", "ask"), false);
});

test("ask-first and read-only always prompt", () => {
  for (const mode of ["agent", "delivery", "plan", "ask"] as const) {
    assert.equal(skipPromptsForApproval("ask-first", mode), false);
    assert.equal(skipPromptsForApproval("read-only", mode), false);
  }
});

test("full access allows a readonly subagent's bash instead of prompting", () => {
  const engine = new PermissionEngine({
    agentRules: rulesForApprovalMode("full-access"),
    configRules: [...(agentForMode("agent").permissions ?? []), ...subagentReadonlyRules({ readonly: true })],
    skipAll: skipPromptsForApproval("full-access", "agent"),
  });
  assert.equal(engine.actionFor({ name: "bash", tier: "execute" }), "allow");
  // The definition's own denies still win over skipAll.
  assert.equal(engine.actionFor({ name: "write", tier: "write" }), "deny");
});
