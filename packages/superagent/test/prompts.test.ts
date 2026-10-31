import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { composePrompt, environmentVariables, workerShellEnvironment } from "../src/agents/prompts.js";
import { PROMPT_DATA } from "../src/prompts-data.js";
import { agentsWorld } from "./agents-world.js";
import { AGENT, makeSettings } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const input = (settings = makeSettings(), extra: Record<string, unknown> = {}) => ({ settings, agent: { login: AGENT, email: "1+agent-bot@users.noreply.github.com" }, ...extra });

test("the embedded prompts are exactly the markdown files shipped in prompts/ and skills/", () => {
  const files: Record<string, string> = {
    shared: "prompts/shared.md", orchestrator: "prompts/orchestrator.md", worker: "prompts/worker.md", admission: "prompts/admission.md", cli: "prompts/cli.md",
    dispatch: "prompts/dispatch.md", handoff: "prompts/handoff.md", "handoff-orchestrator": "prompts/handoff-orchestrator.md", "handoff-worker": "prompts/handoff-worker.md",
    replies: "prompts/replies.md", subscriptions: "prompts/subscriptions.md", work: "prompts/work.md", "team/communication": "prompts/team/communication.md",
    "team/delivery": "prompts/team/delivery.md", "team/scope": "prompts/team/scope.md", "skill/github": "skills/github/SKILL.md",
  };
  for (const [key, file] of Object.entries(files)) assert.equal(PROMPT_DATA[key]?.trim(), readFileSync(join(root, file), "utf8").trim(), `${key} is out of date: run pnpm --filter @deyin/superagent embed`);
  assert.deepEqual(Object.keys(PROMPT_DATA).sort(), Object.keys(files).sort());
});

test("each role's prompt carries its upstream sections verbatim and only its own", () => {
  const orchestrator = composePrompt("orchestrator", input());
  const worker = composePrompt("worker", input(makeSettings(), { ticket: { id: "t1", name: "fix-typo-t1", directory: "/w/fix-typo-t1" } }));
  for (const key of ["shared", "orchestrator", "dispatch", "admission", "replies", "subscriptions"]) assert.ok(orchestrator.includes(PROMPT_DATA[key]!), `orchestrator has ${key}`);
  for (const key of ["shared", "worker", "work", "replies", "subscriptions"]) assert.ok(worker.includes(PROMPT_DATA[key]!), `worker has ${key}`);
  assert.ok(!worker.includes(PROMPT_DATA.dispatch!), "a worker has no dispatch rules");
  assert.ok(!worker.includes(PROMPT_DATA.admission!), "a worker does not assess candidates");
  assert.ok(!orchestrator.includes(PROMPT_DATA.work!), "an orchestrator does not do the work");
  assert.ok(orchestrator.trimEnd().split("\n").some((line) => line.startsWith("## Policy")), "the policy comes with the orchestrator");
  assert.ok(!worker.includes("## Policy"));
});

test("team sections default to the upstream text and take the installation's override", () => {
  const plain = composePrompt("worker", input());
  assert.ok(plain.includes(PROMPT_DATA["team/delivery"]!));
  const custom = composePrompt("worker", input(makeSettings({ prompts: { delivery: "Always open a draft PR." } })));
  assert.ok(custom.includes("Always open a draft PR."));
  assert.ok(!custom.includes(PROMPT_DATA["team/delivery"]!));
});

test("the policy lists the enabled rules and the accept mode", () => {
  const prompt = composePrompt("orchestrator", input(makeSettings({ eval: { mode: "auto" } })));
  assert.match(prompt, /accept mode auto/);
  assert.match(prompt, /Copy fixes \(copy\)/);
  const none = composePrompt("orchestrator", input(makeSettings({ policy: { rules: [] } })));
  assert.match(none, /No rule is enabled/);
});

test("every tool a prompt names exists, and the tools its workflow depends on are named", () => {
  const world = agentsWorld();
  const orchestratorTools = world.orchestrator().map((tool) => tool.name);
  const workerTools = world.worker("t1").map((tool) => tool.name);
  const named = (prompt: string) => new Set(prompt.match(/orchestrator_[a-z_]+/g) ?? []);
  const orchestrator = named(composePrompt("orchestrator", input()));
  const worker = named(composePrompt("worker", input()));
  for (const name of orchestrator) assert.ok(orchestratorTools.includes(name) || workerTools.includes(name), `the orchestrator prompt names ${name}, which is not a tool`);
  for (const name of worker) assert.ok(workerTools.includes(name) || orchestratorTools.includes(name), `the worker prompt names ${name}, which is not a tool`);
  // The rest (retry, notes, requeue, follow, handback) are described by their own tool declarations.
  for (const name of ["orchestrator_read", "orchestrator_route", "orchestrator_eval", "orchestrator_eval_read", "orchestrator_eval_decide", "orchestrator_reply"]) assert.ok(orchestrator.has(name), `${name} is not in the orchestrator prompt`);
  for (const name of ["orchestrator_read", "orchestrator_ack", "orchestrator_report"]) assert.ok(worker.has(name), `${name} is not in the worker prompt`);
});

test("tool declarations are valid json schema objects", () => {
  const world = agentsWorld();
  for (const tool of [...world.orchestrator(), ...world.worker("t1")]) {
    assert.equal(tool.parameters.type, "object", tool.name);
    assert.equal(tool.parameters.additionalProperties, false, tool.name);
    assert.ok(tool.description.length > 20, tool.name);
    assert.doesNotThrow(() => JSON.stringify(tool.parameters), tool.name);
  }
});

test("the worker environment names the ticket and carries credentials only in the shell, never the prompt", () => {
  const settings = makeSettings({ executor: { blockedCommands: ["curl"] } });
  const variables = environmentVariables({ ...input(settings), ticket: { id: "t7", name: "fix-typo-t7", directory: "/w/fix-typo-t7" }, origin: { number: 12, isPr: true } });
  const byKey = Object.fromEntries(variables.map((item) => [item.key, item.value]));
  assert.equal(byKey.DSH_SUPERAGENT_NAME, "fix-typo-t7");
  assert.equal(byKey.DSH_SUPERAGENT_GITHUB_PR_HEAD, "refs/pull/12/head");
  assert.equal(byKey.DSH_SUPERAGENT_GITHUB_REPOSITORY, "acme/app");
  assert.equal(byKey.DSH_SUPERAGENT_BLOCKED_COMMANDS, "curl");
  const env = workerShellEnvironment(variables, { token: "ghp_secret", login: AGENT, email: "e@x" });
  assert.equal(env.GH_TOKEN, "ghp_secret");
  assert.equal(env.GIT_AUTHOR_EMAIL, "e@x");
  assert.equal(env.DSH_SUPERAGENT_DIR, "/w/fix-typo-t7");
  const prompt = composePrompt("worker", { ...input(settings), ticket: { id: "t7", name: "fix-typo-t7", directory: "/w/fix-typo-t7" } });
  assert.ok(!prompt.includes("ghp_secret"));
  assert.ok(!prompt.includes("x-access-token"));
  assert.ok(prompt.includes("DSH_SUPERAGENT_NAME"));
});
