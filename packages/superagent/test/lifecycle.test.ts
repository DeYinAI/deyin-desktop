/** Stopping and starting the runtime again, as the desktop does when the agent account's token is disconnected. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Superagent } from "../src/index.js";
import { FakeGithub } from "./fake-github.js";
import { FakeWorkspace, ScriptedRunner, call, silent } from "./agents-world.js";
import { AGENT, REPO } from "./helpers.js";

const dirs: string[] = [];
const instances: Superagent[] = [];
after(async () => {
  await Promise.all(instances.map((instance) => instance.stop()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const until = async (check: () => boolean, message: string, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for: ${message}`);
};

test("state keeps being saved after the runtime was stopped and started again", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "superagent-lifecycle-"));
  dirs.push(dataDir);
  const fake = new FakeGithub();
  const sa = new Superagent({
    dataDir, runner: new ScriptedRunner(), secrets: { githubToken: () => "ghp_test" }, logger: silent, fetch: fake.fetch, workspace: new FakeWorkspace(),
    now: () => fake.clock.now, tickMs: 10, saveDebounceMs: 10,
  });
  instances.push(sa);
  await sa.start();
  await sa.stop();
  await sa.start();

  // Switched on only after the restart, so everything below is saved by the autosave the restart must have restored.
  sa.saveSettings({ enabled: true, github: { repository: REPO }, policy: { sources: { github: { allowed: [{ id: "alice" }] } } }, eval: { mode: "observe" } }, 0);
  await until(() => sa.view().status.poll.at !== null, "first poll");
  fake.tick();
  fake.addIssue({ number: 1, title: "Typo", user: "alice" });
  fake.tick();
  fake.addComment(1, { user: "alice", body: `@${AGENT} please fix the typo` });
  fake.notify(1);
  fake.tick(61_000);

  const saved = () => {
    try {
      return (JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")) as { triggers: unknown[] }).triggers.length;
    } catch {
      return 0;
    }
  };
  await until(() => saved() > 0, "the trigger reaches state.json");
});

test("stopping waits for a reply that is being posted, so nothing is recorded after the store stopped saving", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "superagent-stop-"));
  dirs.push(dataDir);
  const fake = new FakeGithub();
  let posting = 0;
  let started = 0;
  const slowFetch: typeof fake.fetch = async (url, init) => {
    if (init?.method === "POST") {
      started++;
      posting++;
      try {
        // The post takes a while and does not notice the stop (a response already on its way).
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
      } finally {
        posting--;
      }
    }
    return fake.fetch(url, init);
  };
  const runner = new ScriptedRunner(async (run) => {
    if (run.role === "worker") return new Promise<string>((resolve) => run.signal.addEventListener("abort", () => resolve("")));
    for (const message of run.messages) {
      if (!message.startsWith("{")) continue;
      const card = JSON.parse(message) as { strength?: string; trigger_id: string };
      if (card.strength === "explicit") {
        await call(run.tools, "orchestrator_route", { decisions: [{ kind: "accept", trigger_id: card.trigger_id, title: "Fix", worktree_name: "fix", acknowledgement: "On it." }] });
      }
    }
    return "";
  });
  const sa = new Superagent({
    dataDir, runner, secrets: { githubToken: () => "ghp_test" }, logger: silent, fetch: slowFetch, workspace: new FakeWorkspace(), now: () => fake.clock.now, tickMs: 10, saveDebounceMs: 10,
  });
  instances.push(sa);
  sa.saveSettings({ enabled: true, github: { repository: REPO }, policy: { sources: { github: { allowed: [{ id: "alice" }] } } }, eval: { mode: "observe" } }, 0);
  await sa.start();
  await until(() => sa.view().status.poll.at !== null, "first poll");
  fake.tick();
  fake.addIssue({ number: 1, title: "Typo", user: "alice" });
  fake.tick();
  fake.addComment(1, { user: "alice", body: `@${AGENT} please fix the typo` });
  fake.notify(1);
  fake.tick(61_000);
  await until(() => started > 0, "the acknowledgement is being posted");
  assert.equal(posting, 1);
  await sa.stop();
  assert.equal(posting, 0, "stop returned only after the post ended");
});
