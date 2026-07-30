import assert from "node:assert/strict";
import { test } from "node:test";
import { gitInvocation, parseBlame, parseBranches, parseLog, parseNameStatus, parseRemotes, parseStash, parseStatus } from "../src/host/git.js";
import { windowsSpawnCwd } from "../src/host/wsl-path.js";

test("parseStatus reads the branch header (ahead/behind, upstream)", () => {
  const z = ["# branch.oid abc123", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1"].join("\0") + "\0";
  const s = parseStatus(z);
  assert.equal(s.branch, "main");
  assert.equal(s.detached, false);
  assert.equal(s.upstream, "origin/main");
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
});

test("parseStatus flags a detached HEAD", () => {
  const s = parseStatus("# branch.head (detached)\0");
  assert.equal(s.detached, true);
  assert.equal(s.branch, null);
});

test("parseStatus splits staged/unstaged/untracked/conflicts and resolves renames", () => {
  const z =
    [
      "# branch.head main",
      "1 MM N... 100644 100644 100644 h1 h2 src/app.ts", // staged + unstaged modified
      "1 A. N... 000000 100644 100644 h1 h2 src/new.ts", // staged add only
      "1 .D N... 100644 100644 000000 h1 h2 src/gone.ts", // unstaged delete only
      "2 R. N... 100644 100644 100644 h1 h2 R100 src/renamed.ts", // staged rename (orig next)
      "src/old.ts",
      "u UU N... 100644 100644 100644 100644 h1 h2 h3 src/conflict.ts", // conflict
      "? src/untracked.ts",
    ].join("\0") + "\0";
  const s = parseStatus(z);

  assert.deepEqual(
    s.staged.map((e) => [e.path, e.status, e.orig]),
    [
      ["src/app.ts", "modified", undefined],
      ["src/new.ts", "added", undefined],
      ["src/renamed.ts", "renamed", "src/old.ts"],
    ],
  );
  assert.deepEqual(
    s.unstaged.map((e) => [e.path, e.status]),
    [
      ["src/app.ts", "modified"],
      ["src/gone.ts", "deleted"],
    ],
  );
  assert.deepEqual(s.conflicts.map((e) => e.path), ["src/conflict.ts"]);
  assert.deepEqual(s.untracked.map((e) => e.path), ["src/untracked.ts"]);
});

test("parseStatus handles paths containing spaces", () => {
  const s = parseStatus("1 .M N... 100644 100644 100644 h1 h2 src/my file.ts\0");
  assert.deepEqual(s.unstaged.map((e) => e.path), ["src/my file.ts"]);
});

test("parseBranches maps current/remote/upstream and skips origin/HEAD", () => {
  const raw = [
    "*\0refs/heads/main\0main\0origin/main\0[ahead 2, behind 1]",
    " \0refs/heads/feature\0feature\0\0",
    " \0refs/remotes/origin/main\0origin/main\0\0",
    " \0refs/remotes/origin/HEAD\0origin/HEAD\0\0",
  ].join("\n");
  const branches = parseBranches(raw);

  assert.equal(branches.length, 3);
  const main = branches.find((b) => b.name === "main")!;
  assert.equal(main.current, true);
  assert.equal(main.remote, false);
  assert.equal(main.upstream, "origin/main");
  assert.equal(main.ahead, 2);
  assert.equal(main.behind, 1);

  const feature = branches.find((b) => b.name === "feature")!;
  assert.equal(feature.current, false);
  assert.equal(feature.upstream, undefined);

  const remote = branches.find((b) => b.name === "origin/main")!;
  assert.equal(remote.remote, true);
});

test("gitInvocation routes a WSL2 UNC root through wsl.exe with a POSIX path", () => {
  const inv = gitInvocation("\\\\wsl.localhost\\Ubuntu\\home\\me\\p", ["status", "--porcelain=v2"]);
  assert.equal(inv.cmd, "wsl.exe");
  assert.deepEqual(inv.argv, ["-d", "Ubuntu", "git", "-C", "/home/me/p", "status", "--porcelain=v2"]);
  // wsl.exe must launch from a real Windows dir, never the UNC path.
  assert.equal(inv.cwd, windowsSpawnCwd("\\\\wsl.localhost\\Ubuntu\\home\\me\\p"));
});

test("gitInvocation runs native roots in place", () => {
  const inv = gitInvocation("/home/me/p", ["status"]);
  assert.equal(inv.cmd, "git");
  assert.deepEqual(inv.argv, ["-C", "/home/me/p", "status"]);
  assert.equal(inv.cwd, "/home/me/p");
});

test("parseLog splits commits and parents", () => {
  const raw =
    ["abc123def", "abc123d", "Fix the bug", "Ada", "ada@x.io", "2026-01-02T03:04:05+00:00", "p1 p2"].join("\x1f") +
    "\x1e" +
    ["999000fff", "999000f", "Initial", "Bob", "bob@x.io", "2026-01-01T00:00:00+00:00", ""].join("\x1f") +
    "\x1e";
  const commits = parseLog(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0]!.hash, "abc123def");
  assert.equal(commits[0]!.subject, "Fix the bug");
  assert.deepEqual(commits[0]!.parents, ["p1", "p2"]);
  assert.deepEqual(commits[1]!.parents, []);
});

test("parseNameStatus reads modify/add and rename with orig", () => {
  const z = ["M", "src/a.ts", "A", "src/b.ts", "R100", "src/old.ts", "src/new.ts"].join("\0") + "\0";
  const files = parseNameStatus(z);
  assert.deepEqual(
    files.map((f) => [f.status, f.path, f.orig]),
    [
      ["modified", "src/a.ts", undefined],
      ["added", "src/b.ts", undefined],
      ["renamed", "src/new.ts", "src/old.ts"],
    ],
  );
});

test("parseBlame extracts per-line author/hash/content", () => {
  const raw = [
    "abcd1234ef 1 1 1",
    "author Ada Lovelace",
    "author-time 1735783200",
    "summary first line",
    "\tconst x = 1;",
    "abcd1234ef 2 2",
    "author Ada Lovelace",
    "author-time 1735783200",
    "summary first line",
    "\tconst y = 2;",
  ].join("\n");
  const lines = parseBlame(raw);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.hash, "abcd1234");
  assert.equal(lines[0]!.author, "Ada Lovelace");
  assert.equal(lines[0]!.content, "const x = 1;");
  assert.equal(lines[1]!.line, 2);
  assert.equal(lines[1]!.content, "const y = 2;");
});

test("parseRemotes groups fetch/push URLs by name", () => {
  const raw = [
    "origin\thttps://x/repo.git (fetch)",
    "origin\thttps://x/repo.git (push)",
    "fork\tgit@y:me/repo.git (fetch)",
    "fork\tgit@y:me/repo.git (push)",
  ].join("\n");
  const remotes = parseRemotes(raw);
  assert.equal(remotes.length, 2);
  assert.equal(remotes[0]!.name, "origin");
  assert.equal(remotes[0]!.fetchUrl, "https://x/repo.git");
  assert.equal(remotes[0]!.pushUrl, "https://x/repo.git");
});

test("parseStash reads index and message", () => {
  const raw = ["stash@{0}\x1fWIP on main: abc123 fix", "stash@{1}\x1fOn feature: wip"].join("\n");
  const stashes = parseStash(raw);
  assert.deepEqual(
    stashes.map((s) => [s.index, s.message]),
    [
      [0, "WIP on main: abc123 fix"],
      [1, "On feature: wip"],
    ],
  );
});
