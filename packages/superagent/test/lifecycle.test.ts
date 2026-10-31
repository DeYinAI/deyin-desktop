/** Stopping and starting the runtime again, as the desktop does when the agent account's token is disconnected. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Superagent } from "../src/index.js";
import { FakeGithub } from "./fake-github.js";
import { FakeWorkspace, ScriptedRunner, silent } from "./agents-world.js";
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
