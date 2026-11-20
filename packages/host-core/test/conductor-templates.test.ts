import test from "node:test";
import assert from "node:assert/strict";
import {
  CONDUCTOR_PIPELINE_TEMPLATES,
  findConductorTemplate,
  instantiateConductorTemplate,
  resolveConductorRoleAgent,
  validateConductorWorkflow,
  type ConductorAgentFacts,
  type ConductorRole,
} from "../src/index.js";

const AGENTS: ConductorAgentFacts[] = [
  { id: "claude", installed: true, availableModels: [] },
  { id: "codex", installed: true, availableModels: [] },
  { id: "zcode", installed: true, availableModels: [] },
];

const agentForRole = (role: ConductorRole): string => resolveConductorRoleAgent(role, {}, AGENTS)!.agentId;

test("every template is a valid pipeline once instantiated with a goal", () => {
  for (const template of CONDUCTOR_PIPELINE_TEMPLATES) {
    const pipeline = instantiateConductorTemplate(template, { agentForRole, goal: "Add a dark mode toggle", now: 1 });
    const result = validateConductorWorkflow(pipeline, AGENTS);
    assert.ok(result.ok, `${template.id}: ${result.errors.join("; ")}`);
    assert.deepEqual(result.warnings, [], template.id);
    // The marker must never survive into a prompt the agent would read literally.
    for (const stage of pipeline.stages) {
      assert.ok(!stage.userPromptTemplate.includes("{{goal}}"), `${template.id}/${stage.id}`);
    }
  }
});

test("template ids and stage ids are unique and kebab-case", () => {
  const ids = CONDUCTOR_PIPELINE_TEMPLATES.map((template) => template.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const template of CONDUCTOR_PIPELINE_TEMPLATES) {
    const stageIds = template.stages.map((stage) => stage.id);
    assert.equal(new Set(stageIds).size, stageIds.length, template.id);
    for (const id of [template.id, ...stageIds]) assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
  }
});

test("the agent for each stage comes from its role", () => {
  const pipeline = instantiateConductorTemplate(findConductorTemplate("plan-build-review")!, { agentForRole, goal: "x" });
  assert.deepEqual(
    pipeline.stages.map((stage) => [stage.id, stage.role, stage.agentId]),
    [
      ["plan", "plan", "claude"],
      ["build", "code", "zcode"],
      ["review", "review", "codex"],
    ],
  );
});

test("the goal is written into the prompt, or left as {{inputs.goal}} for a reusable pipeline", () => {
  const template = findConductorTemplate("fix-and-verify")!;
  const withGoal = instantiateConductorTemplate(template, { agentForRole, goal: "  Login fails on Safari  " });
  assert.match(withGoal.stages[0]!.userPromptTemplate, /Login fails on Safari/);

  const reusable = instantiateConductorTemplate(template, { agentForRole });
  assert.match(reusable.stages[0]!.userPromptTemplate, /\{\{inputs\.goal\}\}/);
  // The validator flags that, so the authoring flow only does it on request.
  assert.match(validateConductorWorkflow(reusable, AGENTS).warnings.join("\n"), /\{\{inputs\.\*\}\}/);

  // A goal is plain text, not a replacement pattern.
  const tricky = instantiateConductorTemplate(template, { agentForRole, goal: "keep $& and $1 intact" });
  assert.match(tricky.stages[0]!.userPromptTemplate, /keep \$& and \$1 intact/);
});

test("stages that edit or must see earlier code are isolated; read-only ones on the live tree are not", () => {
  const isolation = (id: string) =>
    Object.fromEntries(
      instantiateConductorTemplate(findConductorTemplate(id)!, { agentForRole, goal: "x" }).stages.map((stage) => [
        stage.id,
        stage.worktree?.isolate,
      ]),
    );
  assert.deepEqual(isolation("plan-build-review"), { plan: false, build: true, review: true });
  assert.deepEqual(isolation("fix-and-verify"), { fix: true, verify: true });
  assert.deepEqual(isolation("review-changes"), { review: false });
  assert.deepEqual(isolation("docs-refresh"), { audit: false, update: true });
});

test("the id defaults to the template id, and an empty id is passed through for the editor", () => {
  const template = findConductorTemplate("review-changes")!;
  assert.equal(instantiateConductorTemplate(template, { agentForRole }).id, "review-changes");
  assert.equal(instantiateConductorTemplate(template, { agentForRole, id: "" }).id, "");
  assert.equal(findConductorTemplate("nope"), undefined);
});

test("only templates that take a goal use it", () => {
  for (const template of CONDUCTOR_PIPELINE_TEMPLATES) {
    const pipeline = instantiateConductorTemplate(template, { agentForRole, goal: "UNIQUE-GOAL-TEXT" });
    const mentionsGoal = pipeline.stages.some((stage) => stage.userPromptTemplate.includes("UNIQUE-GOAL-TEXT"));
    assert.equal(mentionsGoal, template.takesGoal, template.id);
  }
});
