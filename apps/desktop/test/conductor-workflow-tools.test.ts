import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@deyin/agent-core";
import type { ConductorRolePreferences, ConductorWorkflowDefinition, ExternalAgentDescriptor } from "@deyin/host-core";
import { createConductorWorkflowTools, type ConductorWorkflowToolDeps } from "../src/main/conductor-workflow-tools.js";

function agent(id: string, installed = true): ExternalAgentDescriptor {
  return {
    id,
    type: id as ExternalAgentDescriptor["type"],
    name: id,
    binaryName: id,
    installed,
    protocol: "cli" as ExternalAgentDescriptor["protocol"],
    authStatus: "authenticated",
    availableModels: [],
    lastCheckedAt: 0,
  };
}

function workflow(patch: Partial<ConductorWorkflowDefinition> = {}): ConductorWorkflowDefinition {
  return {
    id: "ship-it",
    name: "Ship It",
    createdAt: 1,
    updatedAt: 2,
    stages: [
      { id: "plan", name: "Plan", agentId: "claude", userPromptTemplate: "Plan the work." },
      { id: "build", name: "Build", agentId: "codex", userPromptTemplate: "Do it:\n{{stage.plan.output}}" },
    ],
    ...patch,
  };
}

interface Harness {
  root: string;
  tools: Record<string, ToolDefinition>;
  started: Array<{ workflowId: string; cwd: string; inputs?: Record<string, string> }>;
  cleanup: () => void;
}

function harness(
  opts: {
    saved?: ConductorWorkflowDefinition[];
    agents?: ExternalAgentDescriptor[] | "unavailable";
    rolePreferences?: ConductorRolePreferences;
  } = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), "deyin-conductor-tools-"));
  mkdirSync(join(root, ".deyin", "workflows"), { recursive: true });
  const started: Harness["started"] = [];
  const deps: ConductorWorkflowToolDeps = {
    getWorkspaceRoot: () => root,
    listWorkflows: () => opts.saved ?? [],
    getRolePreferences: opts.rolePreferences ? () => opts.rolePreferences! : undefined,
    listAgents: async () => {
      if (opts.agents === "unavailable") throw new Error("no detector");
      return opts.agents ?? [agent("claude"), agent("codex")];
    },
    startRun: (workflowId, cwd, inputs) => {
      started.push({ workflowId, cwd, inputs });
      return { runId: "run-1" };
    },
  };
  const tools = Object.fromEntries(createConductorWorkflowTools(deps).map((t) => [t.name, t]));
  return { root, tools, started, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const CTX = {} as never;

test("the two tools are registered with the right permission tiers", () => {
  const h = harness();
  try {
    assert.deepEqual(Object.keys(h.tools).sort(), ["conductor_workflow_run", "conductor_workflow_validate"]);
    assert.equal(h.tools.conductor_workflow_validate!.tier, "read");
    assert.equal(h.tools.conductor_workflow_run!.tier, "execute", "starting external agents must not be silent");
  } finally {
    h.cleanup();
  }
});

test("validate accepts a good draft and names the stage chain", async () => {
  const h = harness();
  try {
    const out = await h.tools.conductor_workflow_validate!.execute({ workflow: workflow() }, CTX);
    assert.match(out, /^OK: "Ship It" \(ship-it\) has 2 stages: plan \(claude\) → build \(codex\)\./);
  } finally {
    h.cleanup();
  }
});

test("validate reports every error and tells the model to retry", async () => {
  const h = harness();
  try {
    const bad = workflow({
      stages: [
        { id: "plan", name: "Plan", agentId: "gemini", userPromptTemplate: "{{stage.later.output}}" },
        { id: "later", name: "Later", agentId: "claude", userPromptTemplate: "x" },
      ],
    });
    const out = await h.tools.conductor_workflow_validate!.execute({ workflow: bad }, CTX);
    assert.match(out, /^INVALID: 2 errors\./);
    assert.match(out, /unknown agent "gemini"/);
    assert.match(out, /has not run yet/);
    assert.match(out, /call conductor_workflow_validate again/);
  } finally {
    h.cleanup();
  }
});

test("validate still works, with a note, when agent detection is unavailable", async () => {
  const h = harness({ agents: "unavailable" });
  try {
    const out = await h.tools.conductor_workflow_validate!.execute({ workflow: workflow() }, CTX);
    assert.match(out, /^OK:/);
    assert.match(out, /agents could not be detected/);
  } finally {
    h.cleanup();
  }
});

test("validate by path confirms registration, and says so when the file is not registered", async () => {
  const wf = workflow();
  const registered = harness({ saved: [wf] });
  const orphan = harness({ saved: [] });
  try {
    for (const h of [registered, orphan]) {
      writeFileSync(join(h.root, ".deyin", "workflows", "ship-it.json"), JSON.stringify(wf));
    }
    const yes = await registered.tools.conductor_workflow_validate!.execute({ path: ".deyin/workflows/ship-it.json" }, CTX);
    assert.match(yes, /Registered: it appears in Conductor/);

    const no = await orphan.tools.conductor_workflow_validate!.execute({ path: ".deyin/workflows/ship-it.json" }, CTX);
    assert.match(no, /NOT registered/);
  } finally {
    registered.cleanup();
    orphan.cleanup();
  }
});

test("validate by path rejects traversal, unreadable JSON, and a call with no input", async () => {
  const h = harness();
  try {
    assert.match(await h.tools.conductor_workflow_validate!.execute({ path: "../../etc/passwd" }, CTX), /outside the workspace/);

    writeFileSync(join(h.root, ".deyin", "workflows", "broken.json"), "{ nope");
    assert.match(
      await h.tools.conductor_workflow_validate!.execute({ path: ".deyin/workflows/broken.json" }, CTX),
      /^INVALID: .* could not be read as JSON/,
    );

    assert.match(await h.tools.conductor_workflow_validate!.execute({}, CTX), /pass either `workflow`/);
  } finally {
    h.cleanup();
  }
});

test("run starts a valid pipeline in the workspace and returns without waiting", async () => {
  const h = harness({ saved: [workflow()] });
  try {
    const out = await h.tools.conductor_workflow_run!.execute({ workflow_id: "ship-it" }, CTX);
    assert.match(out, /^Started "Ship It" \(run run-1\): plan \(claude\) → build \(codex\)\./);
    assert.deepEqual(h.started, [{ workflowId: "ship-it", cwd: h.root, inputs: undefined }]);
  } finally {
    h.cleanup();
  }
});

test("run passes a goal through as {{inputs.goal}}", async () => {
  const h = harness({ saved: [workflow()] });
  try {
    await h.tools.conductor_workflow_run!.execute({ workflow_id: "ship-it", goal: "  add login  " }, CTX);
    assert.deepEqual(h.started[0]?.inputs, { goal: "add login" });
  } finally {
    h.cleanup();
  }
});

test("run refuses an unknown id (listing the known ones) and a pipeline that no longer validates", async () => {
  const stale = workflow({
    stages: [{ id: "plan", name: "Plan", agentId: "gemini", userPromptTemplate: "x" }],
  });
  const h = harness({ saved: [workflow(), stale].map((w, i) => (i === 1 ? { ...w, id: "stale" } : w)) });
  try {
    const unknown = await h.tools.conductor_workflow_run!.execute({ workflow_id: "nope" }, CTX);
    assert.match(unknown, /no pipeline with id "nope"\. Known ids: ship-it, stale\./);

    const invalid = await h.tools.conductor_workflow_run!.execute({ workflow_id: "stale" }, CTX);
    assert.match(invalid, /^NOT STARTED\./);
    assert.match(invalid, /unknown agent "gemini"/);

    assert.match(await h.tools.conductor_workflow_run!.execute({}, CTX), /workflow_id is required/);
    assert.deepEqual(h.started, [], "nothing may be launched in any refusal case");
  } finally {
    h.cleanup();
  }
});

test("validate warns, without failing, when a stage's agent differs from the user's preference for its role", async () => {
  const reviewByCodex = workflow({
    stages: [
      { id: "plan", name: "Plan", role: "plan", agentId: "claude", userPromptTemplate: "Plan the work." },
      { id: "review", name: "Review", role: "review", agentId: "codex", userPromptTemplate: "{{stage.plan.output}}" },
    ],
  });
  const prefers = harness({ rolePreferences: { review: "claude" } });
  const none = harness();
  try {
    const out = await prefers.tools.conductor_workflow_validate!.execute({ workflow: reviewByCodex }, CTX);
    assert.match(out, /^OK:/, "a preference is advisory, never an error");
    assert.match(out, /Warnings:\n- .*you prefer "claude" for review stages, but this stage runs "codex"/);

    // No saved preferences, no warning.
    const quiet = await none.tools.conductor_workflow_validate!.execute({ workflow: reviewByCodex }, CTX);
    assert.doesNotMatch(quiet, /you prefer/);

    // A stage that already uses the preferred agent is not flagged.
    const matches = workflow({
      stages: [{ id: "review", name: "Review", role: "review", agentId: "claude", userPromptTemplate: "x" }],
    });
    assert.doesNotMatch(await prefers.tools.conductor_workflow_validate!.execute({ workflow: matches }, CTX), /you prefer/);
  } finally {
    prefers.cleanup();
    none.cleanup();
  }
});

test("validate rejects an unknown role so a typo cannot be saved", async () => {
  const h = harness();
  try {
    const bad = workflow({
      stages: [{ id: "plan", name: "Plan", role: "architect" as never, agentId: "claude", userPromptTemplate: "x" }],
    });
    const out = await h.tools.conductor_workflow_validate!.execute({ workflow: bad }, CTX);
    assert.match(out, /^INVALID: 1 error\./);
    assert.match(out, /"role" must be one of plan, code, review/);
  } finally {
    h.cleanup();
  }
});

test("a role preference never stops a pipeline from running", async () => {
  const mismatched = workflow({
    stages: [{ id: "review", name: "Review", role: "review", agentId: "codex", userPromptTemplate: "x" }],
  });
  const h = harness({ saved: [mismatched], rolePreferences: { review: "claude" } });
  try {
    const out = await h.tools.conductor_workflow_run!.execute({ workflow_id: "ship-it" }, CTX);
    assert.match(out, /^Started "Ship It"/);
    assert.equal(h.started.length, 1);
  } finally {
    h.cleanup();
  }
});
