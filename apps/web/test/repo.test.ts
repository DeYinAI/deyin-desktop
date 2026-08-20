import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { RepoManager, compareUrlFor } from "../src/server/repo.js";

const run = promisify(execFile);

/** Create a bare remote seeded with one commit on `main`. Returns its file:// URL. */
async function makeBareRemote(baseDir: string): Promise<{ url: string; path: string }> {
  const bare = join(baseDir, "remote.git");
  const seed = join(baseDir, "seed");
  await run("git", ["init", "--bare", "--initial-branch=main", bare]);
  await run("git", ["clone", bare, seed]);
  await run("git", ["-C", seed, "config", "user.name", "Seeder"]);
  await run("git", ["-C", seed, "config", "user.email", "seed@example.com"]);
  writeFileSync(join(seed, "README.md"), "# hello\n");
  await run("git", ["-C", seed, "add", "-A"]);
  await run("git", ["-C", seed, "commit", "-m", "seed commit"]);
  await run("git", ["-C", seed, "push", "origin", "main"]);
  return { url: `file://${bare}`, path: bare };
}

function makeRepoManager(root: string): { manager: RepoManager; lines: string[] } {
  const lines: string[] = [];
  const manager = new RepoManager(root, {}, (_stage, line) => lines.push(line));
  return { manager, lines };
}

test("repo: connect clones and creates a deyin work branch off the default branch", async () => {
  const base = mkdtempSync(join(tmpdir(), "deyin-repo-test-"));
  const root = join(base, "sandbox");
  mkdirSync(root);
  try {
    const remote = await makeBareRemote(base);
    const { manager } = makeRepoManager(root);

    const state = await manager.connect({ url: remote.url });
    assert.equal(state.connected, true);
    assert.match(state.branch ?? "", /^deyin\/[a-z0-9-]+-[0-9a-f]{4}$/);
    assert.equal(state.defaultBranch, "main");
    assert.equal(state.url, remote.url);

    // The clone landed inside the sandbox root and we're on the work branch.
    const branch = await run("git", ["-C", root, "symbolic-ref", "--short", "HEAD"]);
    assert.equal(branch.stdout.trim(), state.branch);
    assert.ok(await run("git", ["-C", root, "status"]).then(() => true));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("repo: ship commits leftovers, pushes, merges into main and pushes it", async () => {
  const base = mkdtempSync(join(tmpdir(), "deyin-repo-test-"));
  const root = join(base, "sandbox");
  mkdirSync(root);
  try {
    const remote = await makeBareRemote(base);
    const { manager } = makeRepoManager(root);
    const state = await manager.connect({ url: remote.url });

    // The agent's work: one commit + one uncommitted leftover file.
    writeFileSync(join(root, "feature.txt"), "shipped\n");
    await run("git", ["-C", root, "add", "feature.txt"]);
    await run("git", ["-C", root, "commit", "-m", "add feature"]);
    writeFileSync(join(root, "leftover.txt"), "also ship me\n");

    const result = await manager.ship();
    assert.equal(result.ok, true);
    assert.equal(result.merged, true);
    assert.equal(result.defaultBranch, "main");
    assert.deepEqual(result.commits, ["deyin: task changes", "add feature"]);

    // The remote's main now carries the merge; working tree is clean; we're
    // back on the work branch so follow-up work never lands on main.
    const log = await run("git", ["--git-dir", remote.path, "log", "--format=%s", "main"]);
    assert.match(log.stdout, new RegExp(`Merge ${state.branch} into main`));
    assert.match(log.stdout, /add feature/);
    const status = await run("git", ["-C", root, "status", "--porcelain"]);
    assert.equal(status.stdout.trim(), "");
    const branch = await run("git", ["-C", root, "symbolic-ref", "--short", "HEAD"]);
    assert.equal(branch.stdout.trim(), state.branch);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("repo: reconnect resumes the stored work branch in a fresh sandbox", async () => {
  const base = mkdtempSync(join(tmpdir(), "deyin-repo-test-"));
  const first = join(base, "sandbox-1");
  const second = join(base, "sandbox-2");
  mkdirSync(first);
  mkdirSync(second);
  try {
    const remote = await makeBareRemote(base);

    // Session 1: work + push the branch (what Ship's step 3 does).
    const m1 = makeRepoManager(first);
    const s1 = await m1.manager.connect({ url: remote.url });
    writeFileSync(join(first, "work.txt"), "persisted\n");
    await run("git", ["-C", first, "add", "work.txt"]);
    await run("git", ["-C", first, "commit", "-m", "wip"]);
    await run("git", ["-C", first, "push", "-u", "origin", s1.branch!]);
    // Session 2 (fresh sandbox, same browser): re-clone and resume the branch.
    const m2 = makeRepoManager(second);
    const s2 = await m2.manager.connect({ url: remote.url, branch: s1.branch ?? undefined });
    assert.equal(s2.connected, true);
    assert.equal(s2.branch, s1.branch);
    const content = await run("git", ["-C", second, "show", `origin/${s1.branch ?? ""}:work.txt`]);
    assert.equal(content.stdout, "persisted\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("repo: compareUrlFor builds GitHub compare links only for GitHub remotes", () => {
  assert.equal(
    compareUrlFor("https://github.com/acme/widgets.git", "main", "deyin/widgets-a1b2"),
    "https://github.com/acme/widgets/compare/main...deyin/widgets-a1b2?expand=1",
  );
  assert.equal(
    compareUrlFor("git@github.com:acme/widgets.git", "main", "deyin/x"),
    "https://github.com/acme/widgets/compare/main...deyin/x?expand=1",
  );
  assert.equal(compareUrlFor("https://gitlab.com/acme/widgets.git", "main", "deyin/x"), null);
});
