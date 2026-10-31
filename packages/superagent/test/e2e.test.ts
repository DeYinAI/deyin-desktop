/**
 * End to end: a fake GitHub, a scripted agent, and real git. A person asks for a fix on an issue; the orchestrator accepts it, a
 * worker commits and pushes in its own worktree and reports the pull request, the result is announced, and the merge ends it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Superagent, type AgentRunRequest } from "../src/index.js";
import { GitWorkspace } from "../src/workspace.js";
import { FakeGithub } from "./fake-github.js";
import { ScriptedRunner, call, silent } from "./agents-world.js";
import { AGENT, REPO } from "./helpers.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=seed", "-c", "user.email=seed@example.com", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

const until = async (check: () => boolean | Promise<boolean>, message: string, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for: ${message}`);
};

let dir: string;
let origin: string;
const instances: Superagent[] = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), "superagent-e2e-"));
  origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  git(dir, "init", "--bare", "-b", "main", origin);
  git(dir, "clone", origin, seed);
  writeFileSync(join(seed, "README.md"), "# App\n\nThis is teh readme.\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "init");
  git(seed, "push", "origin", "HEAD:main");
});
after(async () => {
  await Promise.all(instances.map((instance) => instance.stop()));
  rmSync(dir, { recursive: true, force: true });
});

function boot(dataDir: string, fake: FakeGithub, runner: ScriptedRunner) {
  const workspace = new GitWorkspace({ root: join(dataDir, "repos"), ticketsRoot: () => join(dataDir, "work"), logger: silent, remoteUrl: () => origin });
  const sa = new Superagent({
    dataDir, runner, secrets: { githubToken: () => "ghp_e2e" }, logger: silent, fetch: fake.fetch, workspace, now: () => fake.clock.now, tickMs: 10, saveDebounceMs: 10,
  });
  instances.push(sa);
  return sa;
}

test("an explicit request on an issue becomes a pull request that a merge closes", async () => {
  const dataDir = join(dir, "data");
  const fake = new FakeGithub();
  const worktrees: string[] = [];
  const worker = async (run: AgentRunRequest) => {
    const cwd = run.cwd!;
    worktrees.push(cwd);
    const env = { ...process.env, ...run.env };
    assert.equal(run.env.GH_TOKEN, "ghp_e2e");
    assert.equal(run.env.DSH_SUPERAGENT_GITHUB_ACCOUNT, AGENT);
    assert.match(run.systemPrompt, /Execution environment/);
    assert.ok(!run.systemPrompt.includes("ghp_e2e"));
    const run_ = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    const readme = join(cwd, "README.md");
    writeFileSync(readme, readFileSync(readme, "utf8").replace("teh", "the"));
    run_("add", "README.md");
    run_("commit", "-m", "Fix typo in README");
    const branch = run_("rev-parse", "--abbrev-ref", "HEAD");
    run_("push", "origin", `HEAD:${branch}`);
    fake.addIssue({ number: 2, user: AGENT, title: "Fix typo in README", pr: { head: branch } });
    await call(run.tools, "orchestrator_report", { state: "ready", summary: "Fixed the typo; PR #2 is open", pr_number: 2 });
    return "done";
  };
  const orchestrator = async (run: AgentRunRequest) => {
    for (const message of run.messages) {
      if (message.startsWith("{")) {
        const card = JSON.parse(message);
        if (card.strength === "explicit") {
          const answer = await call(run.tools, "orchestrator_route", {
            decisions: [{ kind: "accept", trigger_id: card.trigger_id, title: "Fix README typo", worktree_name: "fix-readme-typo", acknowledgement: "Fixing the README typo and opening a PR." }],
          });
          assert.equal(answer.results[0].decision, "accept", JSON.stringify(answer));
        }
      } else if (/ready/.test(message)) {
        const ticketId = /ticket (t\d+)/.exec(message)![1]!;
        await call(run.tools, "orchestrator_reply", { purpose: "result", ticket_id: ticketId, text: "The fix is ready for review in #2." });
      }
    }
  };
  const runner = new ScriptedRunner((run) => (run.role === "worker" ? worker(run) : orchestrator(run)));
  const sa = boot(dataDir, fake, runner);
  sa.saveSettings(
    { enabled: true, github: { repository: REPO }, policy: { sources: { github: { allowed: [{ id: "alice" }] } } }, eval: { mode: "observe" }, executor: { maxWorkers: 1 } },
    0,
  );
  await sa.start();
  await until(() => sa.view().status.poll.at !== null, "first poll");
  assert.equal(sa.view().status.account?.login, AGENT);
  assert.equal(sa.view().status.ready, true);
  assert.equal(sa.view().tickets.length, 0, "no history is ingested");

  fake.tick();
  fake.addIssue({ number: 1, title: "Typo in README", body: "teh readme has a typo", user: "alice" });
  fake.tick();
  fake.addComment(1, { user: "alice", body: `@${AGENT} please fix the typo in README.md` });
  fake.notify(1);
  fake.tick(61_000);

  await until(() => sa.view().tickets[0]?.state === "person/review", "the ticket reaches review");
  const ticket = sa.view().tickets[0]!;
  assert.equal(ticket.prNumber, 2);
  assert.equal(ticket.requestedBy, "alice");
  assert.equal(ticket.strength, "explicit");
  assert.equal(ticket.assignments[0]?.report?.state, "ready");
  assert.equal(runner.runs.filter((run) => run.role === "worker").length, 1);

  await until(() => fake.posted(1).length === 2, "the acknowledgement and the result are posted");
  const [ack, result] = fake.posted(1);
  assert.match(ack!.body, /Fixing the README typo/);
  assert.match(ack!.body, /deyin-superagent:/);
  assert.match(result!.body, /ready for review in #2/);

  // The work is real: a commit by the agent account on the ticket's branch, pushed to the remote.
  const branch = `agent/${ticket.branch}`;
  assert.equal(git(origin, "log", "-1", "--format=%an <%ae>", branch), `${AGENT} <4242+${AGENT}@users.noreply.github.com>`);
  assert.equal(git(origin, "show", `${branch}:README.md`).includes("This is the readme"), true);
  assert.equal(git(worktrees[0]!, "rev-parse", "--abbrev-ref", "HEAD"), branch);

  // The orchestrator's session was one conversation, and the worker's was keyed by its ticket.
  assert.deepEqual([...new Set(runner.runs.map((run) => run.sessionId))].sort(), ["orchestrator", ticket.id].sort());

  // A merge of the pull request ends the ticket.
  fake.tick();
  fake.close(2, true);
  fake.notify(2);
  fake.tick(61_000);
  await until(() => sa.view().tickets[0]?.state === "merged", "the merge ends the ticket");

  // State survives a restart: nothing is run or sent again.
  await sa.stop();
  const runs = runner.runs.length;
  const posted = fake.posted(1).length;
  const again = boot(dataDir, fake, runner);
  await again.start();
  await until(() => again.view().status.poll.at !== null, "first poll after restart");
  fake.tick(61_000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(again.view().tickets[0]?.state, "merged");
  assert.equal(runner.runs.length, runs);
  assert.equal(fake.posted(1).length, posted);
});
