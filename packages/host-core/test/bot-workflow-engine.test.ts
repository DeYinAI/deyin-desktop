import test from "node:test";
import assert from "node:assert/strict";
import {
  interpolatePrompt,
  BotWorkflowsStore,
  BotWorkflowEngine,
  type BotWorkflowDefinition,
} from "../src/index.js";

test("Prompt interpolator resolves stage outputs, artifacts, and input variables", () => {
  const ctx = {
    stages: {
      "stage-1": {
        output: "Architecture spec: REST endpoints /users and /auth",
        diff: "diff --git a/spec.md b/spec.md",
        branch: "bot/stage-1-8a9b",
      },
      "stage-2": {
        output: "Test suite created with 5 test cases",
      },
    },
    artifacts: [
      { name: "openapi.json", path: "/tmp/openapi.json", stageId: "stage-1", content: '{"openapi":"3.0.0"}' },
    ],
    inputs: {
      goal: "User Authentication",
    },
    workspaceRoot: "/workspace/my-app",
  };

  const template = `Goal: {{inputs.goal}}
Spec from prior: {{stage.stage-1.output}}
Branch: {{stage.stage-1.branch}}
Artifacts:
{{artifacts}}
Workspace: {{workspace.root}}`;

  const rendered = interpolatePrompt(template, ctx);

  assert.match(rendered, /Goal: User Authentication/);
  assert.match(rendered, /Architecture spec: REST endpoints/);
  assert.match(rendered, /bot\/stage-1-8a9b/);
  assert.match(rendered, /openapi\.json/);
  assert.match(rendered, /Workspace: \/workspace\/my-app/);
});

test("BotWorkflowsStore supports save, list, get, and delete", () => {
  const mockStorage = {
    data: new Map<string, any>(),
    readJson<T>(key: string, fallback: T): T {
      return this.data.get(key) ?? fallback;
    },
    writeJson<T>(key: string, val: T): void {
      this.data.set(key, val);
    },
    async flush() {},
    dir: "/tmp",
    cipher: { encrypt: (s: string) => s, decrypt: (s: string) => s },
  };

  const store = new BotWorkflowsStore(mockStorage as any);

  const workflow: BotWorkflowDefinition = {
    id: "wf-1",
    name: "Design and Build",
    description: "Multi-bot pipeline",
    stages: [
      {
        id: "s1",
        name: "Design",
        agentId: "codex",
        userPromptTemplate: "Design {{inputs.feature}}",
      },
      {
        id: "s2",
        name: "Implementation",
        agentId: "claude",
        userPromptTemplate: "Implement:\n{{stage.s1.output}}",
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  store.save(workflow);
  assert.equal(store.list().length, 1);
  assert.equal(store.get("wf-1")?.name, "Design and Build");

  const deleted = store.delete("wf-1");
  assert.equal(deleted, true);
  assert.equal(store.list().length, 0);
});

test("BotWorkflowEngine executes multi-stage workflows and passes context", async () => {
  const engine = new BotWorkflowEngine();

  const workflow: BotWorkflowDefinition = {
    id: "wf-e2e",
    name: "Codex -> Claude Handoff",
    description: "Tests artifact and output chaining",
    stages: [
      {
        id: "stage-spec",
        name: "Draft Specification",
        agentId: "codex",
        userPromptTemplate: "Write spec for {{inputs.feature}}",
      },
      {
        id: "stage-code",
        name: "Generate Code",
        agentId: "claude",
        userPromptTemplate: "Code based on spec:\n{{stage.stage-spec.output}}",
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const executedPrompts: string[] = [];

  const runner = async (opts: any) => {
    executedPrompts.push(opts.prompt);
    opts.onRawLine?.("Processing...");
    return {
      ok: true,
      outputText: `Result from ${opts.agentId} for prompt slice: ${opts.prompt.slice(0, 30)}`,
    };
  };

  const events: any[] = [];
  const state = await engine.execute({
    workflow,
    workspaceRoot: process.cwd(),
    inputs: { feature: "OAuth Login" },
    runner,
    onEvent: (ev) => events.push(ev),
  });

  assert.equal(state.status, "completed");
  assert.equal(state.stages.length, 2);
  assert.equal(state.stages[0]?.status, "completed");
  assert.equal(state.stages[1]?.status, "completed");

  assert.equal(executedPrompts.length, 2);
  assert.match(executedPrompts[0]!, /Write spec for OAuth Login/);
  assert.match(executedPrompts[1]!, /Result from codex/);

  // Check event sequence
  assert.ok(events.some((e) => e.type === "workflow:started"));
  assert.ok(events.some((e) => e.type === "stage:started" && e.stageId === "stage-spec"));
  assert.ok(events.some((e) => e.type === "stage:completed" && e.stageId === "stage-spec"));
  assert.ok(events.some((e) => e.type === "stage:started" && e.stageId === "stage-code"));
  assert.ok(events.some((e) => e.type === "workflow:completed"));
});
