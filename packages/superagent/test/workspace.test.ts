import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { GitWorkspace } from "../src/workspace.js";
import { silent } from "./agents-world.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let dir: string;
let origin: string;
let workspace: GitWorkspace;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "superagent-ws-"));
  origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  git(dir, "init", "--bare", "-b", "main", origin);
  git(dir, "clone", origin, seed);
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "init");
  git(seed, "push", "origin", "HEAD:main");
  workspace = new GitWorkspace({ root: join(dir, "repos"), ticketsRoot: () => join(dir, "tickets"), logger: silent, remoteUrl: () => origin });
});
after(() => rmSync(dir, { recursive: true, force: true }));

const input = (name: string, extra: Record<string, unknown> = {}) => ({
  name, directory: join(dir, "tickets", name), branch: `agent/${name}`, repository: "acme/app", checkout: "", env: {}, ...extra,
});

test("prepare clones once, adds a worktree on a fresh branch from the default branch, and is idempotent", async () => {
  await workspace.prepare(input("fix-typo-t1"));
  const directory = join(dir, "tickets", "fix-typo-t1");
  assert.equal(readFileSync(join(directory, "README.md"), "utf8"), "hello\n");
  assert.equal(git(directory, "rev-parse", "--abbrev-ref", "HEAD"), "agent/fix-typo-t1");
  assert.ok(existsSync(join(dir, "repos", "acme__app", ".git")));
  writeFileSync(join(directory, "work.txt"), "in progress\n");
  await workspace.prepare(input("fix-typo-t1"));
  assert.equal(readFileSync(join(directory, "work.txt"), "utf8"), "in progress\n", "a ready worktree is left alone");
  await workspace.prepare(input("second-task-t2"));
  assert.equal(git(join(dir, "tickets", "second-task-t2"), "rev-parse", "--abbrev-ref", "HEAD"), "agent/second-task-t2");
});

test("prepare reuses a branch that exists locally or on the remote", async () => {
  const clone = join(dir, "repos", "acme__app");
  git(clone, "branch", "agent/local-branch-t3", "origin/main");
  await workspace.prepare(input("local-branch-t3"));
  assert.equal(git(join(dir, "tickets", "local-branch-t3"), "rev-parse", "--abbrev-ref", "HEAD"), "agent/local-branch-t3");
  const seed = join(dir, "seed");
  git(seed, "checkout", "-b", "agent/remote-branch-t4");
  writeFileSync(join(seed, "remote.txt"), "pushed earlier\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "earlier work");
  git(seed, "push", "origin", "agent/remote-branch-t4");
  await workspace.prepare(input("remote-branch-t4"));
  assert.equal(readFileSync(join(dir, "tickets", "remote-branch-t4", "remote.txt"), "utf8"), "pushed earlier\n");
});

test("prepare refuses a directory outside the tickets root and a checkout that is not a repository", async () => {
  await assert.rejects(workspace.prepare(input("escape", { directory: join(dir, "elsewhere") })), /outside the tickets directory/);
  await assert.rejects(workspace.prepare(input("dotdot", { directory: join(dir, "tickets", "..", "x") })), /outside the tickets directory/);
  await assert.rejects(workspace.prepare(input("nocheckout-t5", { checkout: join(dir, "not-a-repo") })), /not a git checkout/);
});

test("prepare adds the worktree to a configured checkout instead of cloning", async () => {
  const mine = join(dir, "mine");
  git(dir, "clone", origin, mine);
  await workspace.prepare(input("in-my-checkout-t6", { checkout: mine }));
  assert.equal(git(join(dir, "tickets", "in-my-checkout-t6"), "rev-parse", "--abbrev-ref", "HEAD"), "agent/in-my-checkout-t6");
  assert.match(git(mine, "worktree", "list"), /in-my-checkout-t6/);
});

test("remove deletes the worktree and its directory, and only inside the tickets root", async () => {
  const directory = join(dir, "tickets", "fix-typo-t1");
  await workspace.remove({ directory });
  assert.equal(existsSync(directory), false);
  await assert.rejects(workspace.remove({ directory: join(dir, "repos") }), /outside the tickets directory/);
  assert.ok(existsSync(join(dir, "repos", "acme__app")));
});

test("concurrent prepares of one repository do not collide", async () => {
  await Promise.all([workspace.prepare(input("parallel-one-t7")), workspace.prepare(input("parallel-two-t8")), workspace.prepare(input("parallel-three-t9"))]);
  for (const name of ["parallel-one-t7", "parallel-two-t8", "parallel-three-t9"]) assert.ok(existsSync(join(dir, "tickets", name, "README.md")));
});
