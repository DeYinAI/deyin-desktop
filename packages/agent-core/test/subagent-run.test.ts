import assert from "node:assert/strict";
import { test } from "node:test";
import {
  READONLY_RULES,
  agentForMode,
  resolveSubagentModel,
  rulesForApprovalMode,
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
