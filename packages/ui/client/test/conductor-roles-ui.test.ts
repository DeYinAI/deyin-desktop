/** Conductor's role UI: the per-role agent menu in Settings, and the starter pipeline cards. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CONDUCTOR_PIPELINE_TEMPLATES, CONDUCTOR_ROLE_INFO, findConductorTemplate } from "@deyin/host-core/shared";
import type { ExternalAgentDescriptor } from "@deyin/contract";
import { PipelineTemplateCards } from "../src/components/PipelineTemplateCards.js";
import { TEMPLATE_GOAL_PLACEHOLDER, draftFromTemplate } from "../src/components/pipelineTemplateDraft.js";
import { ConductorPage } from "../src/components/settings/ConductorPage.js";
import {
  AUTOMATIC_AGENT_ID,
  conductorRoleOptions,
  withRoleChoice,
} from "../src/components/settings/conductorRoleOptions.js";

const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", zcode: "ZCode", opencode: "OpenCode" };

function agent(id: string, patch: Partial<ExternalAgentDescriptor> = {}): ExternalAgentDescriptor {
  return {
    id,
    type: id as ExternalAgentDescriptor["type"],
    name: NAMES[id] ?? id,
    binaryName: id,
    installed: true,
    protocol: "cli" as ExternalAgentDescriptor["protocol"],
    authStatus: "authenticated",
    availableModels: [],
    lastCheckedAt: 0,
    ...patch,
  };
}

test("Automatic names the agent a role would use and why", () => {
  const all = [agent("claude"), agent("codex"), agent("zcode")];
  const [automatic] = conductorRoleOptions("code", all, {});
  assert.equal(automatic!.id, AUTOMATIC_AGENT_ID);
  assert.equal(automatic!.label, "Automatic · ZCode");
  assert.equal(automatic!.hint, "The usual choice for this kind of work.");
});

test("Automatic falls back to the first installed agent and says the usual one is missing", () => {
  const withoutZcode = [agent("claude"), agent("codex"), agent("zcode", { installed: false })];
  const [automatic] = conductorRoleOptions("code", withoutZcode, {});
  assert.equal(automatic!.label, "Automatic · Claude Code");
  assert.equal(automatic!.hint, "ZCode is not installed, so the first installed agent is used.");

  // A role with no usual choice never claims one is missing.
  const [test_] = conductorRoleOptions("test", withoutZcode, {});
  assert.equal(test_!.label, "Automatic · Claude Code");
  assert.equal(test_!.hint, "No usual choice for this role, so the first installed agent is used.");
});

test("with nothing installed the menu offers only Automatic, and says so", () => {
  const options = conductorRoleOptions("plan", [agent("claude", { installed: false })], {});
  assert.equal(options.length, 1);
  assert.equal(options[0]!.label, "Automatic");
  assert.equal(options[0]!.hint, "No agent is installed.");
});

test("only installed agents can be picked, and a signed-out one is flagged", () => {
  const all = [agent("claude"), agent("codex", { authStatus: "unauthenticated" }), agent("zcode", { installed: false })];
  const options = conductorRoleOptions("review", all, {});
  assert.deepEqual(
    options.map((option) => option.id),
    [AUTOMATIC_AGENT_ID, "claude", "codex"],
  );
  assert.equal(options.find((option) => option.id === "codex")!.hint, "Not signed in");
  assert.equal(options.find((option) => option.id === "claude")!.hint, undefined);
});

test("a saved choice whose agent was uninstalled stays visible but cannot be picked", () => {
  const all = [agent("claude"), agent("zcode", { installed: false })];
  const options = conductorRoleOptions("code", all, { code: "zcode" });
  const stale = options.find((option) => option.id === "zcode")!;
  assert.equal(stale.label, "ZCode (not installed)");
  assert.equal(stale.disabled, true);

  // An installed saved choice is the normal entry, not a duplicate.
  const fine = conductorRoleOptions("code", all, { code: "claude" });
  assert.equal(fine.filter((option) => option.id === "claude").length, 1);
  assert.ok(!fine.some((option) => option.disabled));
});

test("withRoleChoice sets and clears one role without touching the others or the input", () => {
  const before = { plan: "claude", review: "codex" };
  const set = withRoleChoice(before, "code", "zcode");
  assert.deepEqual(set, { plan: "claude", review: "codex", code: "zcode" });
  const cleared = withRoleChoice(before, "plan", AUTOMATIC_AGENT_ID);
  assert.deepEqual(cleared, { review: "codex" });
  assert.deepEqual(before, { plan: "claude", review: "codex" });
});

test("the Settings page renders its heading and the detect button before agents arrive", () => {
  const markup = renderToStaticMarkup(createElement(ConductorPage, { preferences: {}, onChange: () => {} }));
  assert.match(markup, />Conductor</);
  assert.match(markup, /Detect agents again/);
  assert.match(markup, /Detecting installed agents/);
});

test("the template cards list every starter pipeline with its stages by role", () => {
  const markup = renderToStaticMarkup(createElement(PipelineTemplateCards, { onPick: () => {} }));
  assert.match(markup, /Or start from a template/);
  assert.equal((markup.match(/<button /g) ?? []).length, CONDUCTOR_PIPELINE_TEMPLATES.length);
  for (const template of CONDUCTOR_PIPELINE_TEMPLATES) {
    assert.ok(markup.includes(template.name), template.name);
    const chain = template.stages.map((stage) => CONDUCTOR_ROLE_INFO[stage.role].label).join(" → ");
    assert.ok(markup.includes(chain), `${template.id}: ${chain}`);
  }
  assert.match(markup, /Plan → Code → Review/);
});

const planBuildReview = () => findConductorTemplate("plan-build-review")!;
const agentsOf = (draft: ReturnType<typeof draftFromTemplate>) => draft.stages.map((stage) => stage.agentId);

test("a template draft gives each stage the agent for its role", () => {
  const all = [agent("claude"), agent("codex"), agent("zcode")];
  const draft = draftFromTemplate(planBuildReview(), all, {});
  assert.deepEqual(agentsOf(draft), ["claude", "zcode", "codex"]);
  assert.equal(draft.id, "", "unsaved: the editor derives the id from the name on save");
  assert.deepEqual(
    draft.stages.map((stage) => stage.role),
    ["plan", "code", "review"],
  );
});

test("a template draft honors the user's role preferences and falls back to an installed agent", () => {
  const all = [agent("claude"), agent("codex"), agent("zcode", { installed: false })];
  // ZCode is the usual coder but is not installed: the first installed agent builds instead.
  assert.deepEqual(agentsOf(draftFromTemplate(planBuildReview(), all, {})), ["claude", "claude", "codex"]);
  // An explicit choice beats the usual one.
  assert.deepEqual(agentsOf(draftFromTemplate(planBuildReview(), all, { review: "claude", plan: "codex" })), [
    "codex",
    "claude",
    "claude",
  ]);
  // A stale choice for an agent that is gone is ignored.
  assert.deepEqual(agentsOf(draftFromTemplate(planBuildReview(), all, { code: "zcode" })), ["claude", "claude", "codex"]);
  // Nothing installed: still a well-formed draft the user can fix in the editor.
  assert.deepEqual(agentsOf(draftFromTemplate(planBuildReview(), [], {})), ["codex", "codex", "codex"]);
});

test("a template draft shows an editable goal instead of a variable that runs empty", () => {
  const draft = draftFromTemplate(planBuildReview(), [agent("claude")], {});
  const first = draft.stages[0]!.userPromptTemplate;
  assert.ok(first.includes(TEMPLATE_GOAL_PLACEHOLDER));
  assert.ok(!first.includes("{{inputs.goal}}"), "the Execute button passes no inputs");
  assert.ok(!first.includes("{{goal}}"));
});
