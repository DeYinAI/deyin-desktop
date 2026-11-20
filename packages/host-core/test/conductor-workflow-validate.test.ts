import test from "node:test";
import assert from "node:assert/strict";
import { validateConductorWorkflow, type ConductorAgentFacts } from "../src/index.js";

const AGENTS: ConductorAgentFacts[] = [
  { id: "claude", installed: true, availableModels: ["opus-5.0", "claude-4.6-sonnet"] },
  { id: "codex", installed: true, availableModels: [] },
  { id: "opencode", installed: false, availableModels: [] },
];

function pipeline(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ship-feature",
    name: "Ship Feature",
    createdAt: 1,
    updatedAt: 2,
    stages: [
      { id: "plan", name: "Plan", agentId: "claude", userPromptTemplate: "Plan the login page." },
      {
        id: "build",
        name: "Build",
        agentId: "codex",
        userPromptTemplate: "Implement:\n{{stage.plan.output}}",
      },
      {
        id: "review",
        name: "Review",
        agentId: "claude",
        userPromptTemplate: "Review {{stage.build.diff}} against {{stage.plan.output}}",
      },
    ],
    ...patch,
  };
}

test("a well-formed pipeline passes and hands back the definition", () => {
  const result = validateConductorWorkflow(pipeline(), AGENTS);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.ok);
  assert.equal(result.workflow?.stages.length, 3);
});

test("anything that is not an object is rejected", () => {
  for (const raw of [null, "pipeline", 3, []]) {
    const result = validateConductorWorkflow(raw);
    assert.equal(result.ok, false);
    assert.equal(result.workflow, undefined);
  }
});

test("required fields and the id shape are enforced (the id becomes a file name)", () => {
  const result = validateConductorWorkflow({ id: "../evil", stages: [] });
  assert.equal(result.ok, false);
  const joined = result.errors.join("\n");
  assert.match(joined, /"id" must be kebab-case/);
  assert.match(joined, /Missing "name"/);
  assert.match(joined, /createdAt/);
  assert.match(joined, /"stages" must be a non-empty array/);
});

test("duplicate stage ids and dotted ids are errors", () => {
  const dup = pipeline({
    stages: [
      { id: "a", name: "A", agentId: "claude", userPromptTemplate: "x" },
      { id: "a", name: "B", agentId: "claude", userPromptTemplate: "y" },
    ],
  });
  assert.match(validateConductorWorkflow(dup, AGENTS).errors.join("\n"), /duplicate stage id/);

  const dotted = pipeline({ stages: [{ id: "step.one", name: "A", agentId: "claude", userPromptTemplate: "x" }] });
  assert.match(validateConductorWorkflow(dotted, AGENTS).errors.join("\n"), /kebab-case/);
});

test("stage references must point at stages that run earlier", () => {
  const forward = pipeline({
    stages: [
      { id: "a", name: "A", agentId: "claude", userPromptTemplate: "use {{stage.b.output}}" },
      { id: "b", name: "B", agentId: "claude", userPromptTemplate: "go" },
    ],
  });
  assert.match(validateConductorWorkflow(forward, AGENTS).errors.join("\n"), /has not run yet/);

  const self = pipeline({ stages: [{ id: "a", name: "A", agentId: "claude", userPromptTemplate: "{{stage.a.output}}" }] });
  assert.match(validateConductorWorkflow(self, AGENTS).errors.join("\n"), /has not run yet/);

  const missing = pipeline({
    stages: [
      { id: "a", name: "A", agentId: "claude", userPromptTemplate: "go" },
      { id: "b", name: "B", agentId: "claude", userPromptTemplate: "{{stage.nope.output}}" },
    ],
  });
  assert.match(validateConductorWorkflow(missing, AGENTS).errors.join("\n"), /does not exist/);
});

test("agent ids are checked against the detected agents; an uninstalled one only warns", () => {
  const unknown = pipeline({ stages: [{ id: "a", name: "A", agentId: "gemini", userPromptTemplate: "x" }] });
  const bad = validateConductorWorkflow(unknown, AGENTS);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0]!, /unknown agent "gemini".*claude, codex, opencode/);

  const uninstalled = pipeline({ stages: [{ id: "a", name: "A", agentId: "opencode", userPromptTemplate: "x" }] });
  const warned = validateConductorWorkflow(uninstalled, AGENTS);
  assert.ok(warned.ok);
  assert.match(warned.warnings[0]!, /not installed/);

  // Without a detector there is nothing to compare against.
  assert.ok(validateConductorWorkflow(unknown).ok);
});

test("an unlisted model override warns but does not fail", () => {
  const result = validateConductorWorkflow(
    pipeline({ stages: [{ id: "a", name: "A", agentId: "claude", modelOverride: "mystery", userPromptTemplate: "x" }] }),
    AGENTS,
  );
  assert.ok(result.ok);
  assert.match(result.warnings[0]!, /model "mystery" is not in claude's detected models/);
});

test("{{inputs.*}} warns once, because the Run button and the scheduler pass no inputs", () => {
  const result = validateConductorWorkflow(
    pipeline({
      stages: [
        { id: "a", name: "A", agentId: "claude", userPromptTemplate: "{{inputs.goal}}" },
        { id: "b", name: "B", agentId: "claude", userPromptTemplate: "{{inputs.goal}} again" },
      ],
    }),
    AGENTS,
  );
  assert.ok(result.ok);
  assert.equal(result.warnings.filter((w) => w.includes("{{inputs.*}}")).length, 1);
});

test("unknown variables warn; known ones do not", () => {
  const result = validateConductorWorkflow(
    pipeline({
      stages: [
        { id: "a", name: "A", agentId: "claude", userPromptTemplate: "{{workspace.root}} {{artifacts}}" },
        { id: "b", name: "B", agentId: "claude", userPromptTemplate: "{{stage.a.verdict}} {{whatever}}" },
      ],
    }),
    AGENTS,
  );
  assert.ok(result.ok);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join("\n"), /no "verdict" property/);
  assert.match(result.warnings.join("\n"), /\{\{whatever\}\} is not a known variable/);
});

test("watchdog and schedule settings are checked", () => {
  const badWatchdog = pipeline({
    stages: [
      {
        id: "a",
        name: "A",
        agentId: "claude",
        userPromptTemplate: "x",
        watchdog: { timeoutMs: -1, stallThresholdMs: 0, onStallAction: "panic" },
      },
    ],
  });
  const errors = validateConductorWorkflow(badWatchdog, AGENTS).errors.join("\n");
  assert.match(errors, /timeoutMs/);
  assert.match(errors, /stallThresholdMs/);
  assert.match(errors, /onStallAction/);

  const slowStall = pipeline({
    stages: [
      {
        id: "a",
        name: "A",
        agentId: "claude",
        userPromptTemplate: "x",
        watchdog: { timeoutMs: 1000, stallThresholdMs: 2000, onStallAction: "alert-user" },
      },
    ],
  });
  const warned = validateConductorWorkflow(slowStall, AGENTS);
  assert.ok(warned.ok);
  assert.match(warned.warnings[0]!, /stall threshold is not shorter/);

  const emptySchedule = pipeline({ schedule: { enabled: true } });
  assert.match(validateConductorWorkflow(emptySchedule, AGENTS).errors.join("\n"), /neither a "cronExpression" nor/);
  assert.ok(validateConductorWorkflow(pipeline({ schedule: { enabled: true, cronExpression: "0 * * * *" } }), AGENTS).ok);
});

function rolePipeline(...stages: Array<{ id: string; role?: unknown; agentId: string }>): Record<string, unknown> {
  return pipeline({
    stages: stages.map((stage) => ({ name: stage.id, userPromptTemplate: "x", ...stage })),
  });
}

test("a known stage role is accepted; an unknown one is an error", () => {
  const ok = validateConductorWorkflow(rolePipeline({ id: "plan", role: "plan", agentId: "claude" }), AGENTS);
  assert.ok(ok.ok, ok.errors.join("\n"));
  assert.deepEqual(ok.warnings, []);

  const bad = validateConductorWorkflow(rolePipeline({ id: "plan", role: "manager", agentId: "claude" }), AGENTS);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("\n"), /"role" must be one of plan, code, review/);

  // A role is optional: stages written before roles existed stay valid.
  assert.ok(validateConductorWorkflow(rolePipeline({ id: "plan", agentId: "claude" }), AGENTS).ok);
});

test("a stage that ignores the user's chosen agent for its role gets a warning, not an error", () => {
  const stages = rolePipeline(
    { id: "plan", role: "plan", agentId: "codex" },
    { id: "review", role: "review", agentId: "codex" },
  );
  const result = validateConductorWorkflow(stages, AGENTS, { rolePreferences: { plan: "claude", review: "codex" } });
  assert.ok(result.ok);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /you prefer "claude" for plan stages, but this stage runs "codex"/);
});

test("role warnings need an explicit, installed preference", () => {
  const stages = rolePipeline({ id: "plan", role: "plan", agentId: "codex" });
  // No preference saved: the built-in default (claude) is only a suggestion.
  assert.deepEqual(validateConductorWorkflow(stages, AGENTS).warnings, []);
  assert.deepEqual(validateConductorWorkflow(stages, AGENTS, { rolePreferences: {} }).warnings, []);
  // The preferred agent is not installed, so there is nothing better to switch to.
  assert.deepEqual(validateConductorWorkflow(stages, AGENTS, { rolePreferences: { plan: "opencode" } }).warnings, []);
  // The "custom" role carries no preference.
  const custom = rolePipeline({ id: "misc", role: "custom", agentId: "codex" });
  assert.deepEqual(validateConductorWorkflow(custom, AGENTS, { rolePreferences: { plan: "claude" } }).warnings, []);
});
