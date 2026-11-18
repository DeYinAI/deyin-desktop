import test from "node:test";
import assert from "node:assert/strict";
import { validateBotWorkflow, type BotAgentFacts } from "../src/index.js";

const AGENTS: BotAgentFacts[] = [
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
  const result = validateBotWorkflow(pipeline(), AGENTS);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.ok);
  assert.equal(result.workflow?.stages.length, 3);
});

test("anything that is not an object is rejected", () => {
  for (const raw of [null, "pipeline", 3, []]) {
    const result = validateBotWorkflow(raw);
    assert.equal(result.ok, false);
    assert.equal(result.workflow, undefined);
  }
});

test("required fields and the id shape are enforced (the id becomes a file name)", () => {
  const result = validateBotWorkflow({ id: "../evil", stages: [] });
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
  assert.match(validateBotWorkflow(dup, AGENTS).errors.join("\n"), /duplicate stage id/);

  const dotted = pipeline({ stages: [{ id: "step.one", name: "A", agentId: "claude", userPromptTemplate: "x" }] });
  assert.match(validateBotWorkflow(dotted, AGENTS).errors.join("\n"), /kebab-case/);
});

test("stage references must point at stages that run earlier", () => {
  const forward = pipeline({
    stages: [
      { id: "a", name: "A", agentId: "claude", userPromptTemplate: "use {{stage.b.output}}" },
      { id: "b", name: "B", agentId: "claude", userPromptTemplate: "go" },
    ],
  });
  assert.match(validateBotWorkflow(forward, AGENTS).errors.join("\n"), /has not run yet/);

  const self = pipeline({ stages: [{ id: "a", name: "A", agentId: "claude", userPromptTemplate: "{{stage.a.output}}" }] });
  assert.match(validateBotWorkflow(self, AGENTS).errors.join("\n"), /has not run yet/);

  const missing = pipeline({
    stages: [
      { id: "a", name: "A", agentId: "claude", userPromptTemplate: "go" },
      { id: "b", name: "B", agentId: "claude", userPromptTemplate: "{{stage.nope.output}}" },
    ],
  });
  assert.match(validateBotWorkflow(missing, AGENTS).errors.join("\n"), /does not exist/);
});

test("agent ids are checked against the detected agents; an uninstalled one only warns", () => {
  const unknown = pipeline({ stages: [{ id: "a", name: "A", agentId: "gemini", userPromptTemplate: "x" }] });
  const bad = validateBotWorkflow(unknown, AGENTS);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0]!, /unknown agent "gemini".*claude, codex, opencode/);

  const uninstalled = pipeline({ stages: [{ id: "a", name: "A", agentId: "opencode", userPromptTemplate: "x" }] });
  const warned = validateBotWorkflow(uninstalled, AGENTS);
  assert.ok(warned.ok);
  assert.match(warned.warnings[0]!, /not installed/);

  // Without a detector there is nothing to compare against.
  assert.ok(validateBotWorkflow(unknown).ok);
});

test("an unlisted model override warns but does not fail", () => {
  const result = validateBotWorkflow(
    pipeline({ stages: [{ id: "a", name: "A", agentId: "claude", modelOverride: "mystery", userPromptTemplate: "x" }] }),
    AGENTS,
  );
  assert.ok(result.ok);
  assert.match(result.warnings[0]!, /model "mystery" is not in claude's detected models/);
});

test("{{inputs.*}} warns once, because the Run button and the scheduler pass no inputs", () => {
  const result = validateBotWorkflow(
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
  const result = validateBotWorkflow(
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
  const errors = validateBotWorkflow(badWatchdog, AGENTS).errors.join("\n");
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
  const warned = validateBotWorkflow(slowStall, AGENTS);
  assert.ok(warned.ok);
  assert.match(warned.warnings[0]!, /stall threshold is not shorter/);

  const emptySchedule = pipeline({ schedule: { enabled: true } });
  assert.match(validateBotWorkflow(emptySchedule, AGENTS).errors.join("\n"), /neither a "cronExpression" nor/);
  assert.ok(validateBotWorkflow(pipeline({ schedule: { enabled: true, cronExpression: "0 * * * *" } }), AGENTS).ok);
});
