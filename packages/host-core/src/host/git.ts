import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  GitBlameLine,
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitFileDiff,
  GitFileEntry,
  GitFileStatus,
  GitRemote,
  GitRepoInfo,
  GitStash,
  GitStatus,
} from "../types.js";
import { toWslPath, windowsSpawnCwd, wslUncDistro } from "./wsl-path.js";

/**
 * System-`git` service. All operations take the workspace `root` and route through
 * {@link gitInvocation}, which sends commands to the right distro when the root lives
 * inside WSL2 (a `\\wsl$` UNC path). Parsers are pure and exported for unit testing.
 */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface GitInvocation {
  cmd: string;
  argv: string[];
  cwd: string;
}

/**
 * Build the argv + spawn cwd for a git command. A WSL2 UNC root runs as
 * `wsl.exe -d <distro> git -C <posix-path> …` launched from a real Windows dir
 * (CreateProcess rejects UNC/POSIX cwds); everything else runs `git -C <root>`.
 */
export function gitInvocation(root: string, args: string[]): GitInvocation {
  const distro = wslUncDistro(root);
  if (distro) {
    // wsl.exe is a Windows process launched from a safe Windows dir; git runs in
    // the distro at the POSIX form of the root.
    return { cmd: "wsl.exe", argv: ["-d", distro, "git", "-C", toWslPath(root), ...args], cwd: windowsSpawnCwd(root) };
  }
  // Native root (POSIX on Linux/mac, or a Windows drive path): git runs there directly.
  return { cmd: "git", argv: ["-C", root, ...args], cwd: root };
}

/** Run a git command. Never rejects: spawn failures resolve to `{ ok: false, code: null }`. */
export function runGit(root: string, args: string[], opts: { signal?: AbortSignal; stdin?: string } = {}): Promise<GitResult> {
  const { cmd, argv, cwd } = gitInvocation(root, args);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, {
        cwd,
        // No locks on read ops, never page, never block on a credential prompt.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
        windowsHide: true,
        signal: opts.signal,
      });
    } catch (err) {
      resolve({ ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err), code: null });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => resolve({ ok: false, stdout, stderr: stderr || err.message, code: null }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr, code }));
    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts.stdin);
    }
  });
}

/* Parsers (pure) ------------------------------------------------------------- */

function codeToStatus(code: string): GitFileStatus {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "U":
      return "conflicted";
    case "T":
      return "typechange";
    default:
      return "modified";
  }
}

/** Substring after the nth (1-based) space in `s`. */
function afterNthSpace(s: string, n: number): string {
  let idx = -1;
  for (let k = 0; k < n; k++) {
    idx = s.indexOf(" ", idx + 1);
    if (idx === -1) return "";
  }
  return s.slice(idx + 1);
}

function emptyStatus(): GitStatus {
  return { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [] };
}

/** Parse `git status --porcelain=v2 --branch -z` output. */
export function parseStatus(z: string): GitStatus {
  const status = emptyStatus();
  const fields = z.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i];
    if (!line) continue;

    if (line.startsWith("# ")) {
      const head = line.slice(2);
      if (head.startsWith("branch.head ")) {
        const value = head.slice("branch.head ".length);
        if (value === "(detached)") status.detached = true;
        else status.branch = value;
      } else if (head.startsWith("branch.upstream ")) {
        status.upstream = head.slice("branch.upstream ".length);
      } else if (head.startsWith("branch.ab ")) {
        const m = /\+(\d+)\s+-(\d+)/.exec(head);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }

    const type = line[0];
    if (type === "1" || type === "2") {
      const xy = line.slice(2, 4);
      const x = xy[0]!;
      const y = xy[1]!;
      // Ordinary entries have 8 leading fields, renames/copies have 9 (extra score).
      const path = afterNthSpace(line, type === "1" ? 8 : 9);
      // For a rename (type 2, -z), the original path is the next NUL field.
      const orig = type === "2" ? fields[++i] : undefined;
      if (x !== ".") status.staged.push({ path, orig, status: codeToStatus(x), staged: true });
      if (y !== ".") status.unstaged.push({ path, status: codeToStatus(y), staged: false });
    } else if (type === "u") {
      const path = afterNthSpace(line, 10);
      status.conflicts.push({ path, status: "conflicted", staged: false });
    } else if (type === "?") {
      status.untracked.push({ path: line.slice(2), status: "untracked", staged: false });
    }
    // "!" ignored entries are skipped.
  }
  return status;
}

const BRANCH_FORMAT = "%(HEAD)%00%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track)";

/** Parse `git for-each-ref --format=<BRANCH_FORMAT> refs/heads refs/remotes`. */
export function parseBranches(raw: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [head, refname, short, upstream, track] = line.split("\0");
    if (!refname || !short) continue;
    // Skip the symbolic origin/HEAD pointer.
    if (short.endsWith("/HEAD")) continue;
    const branch: GitBranch = {
      name: short,
      current: head === "*",
      remote: refname.startsWith("refs/remotes/"),
    };
    if (upstream) branch.upstream = upstream;
    if (track) {
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      if (ahead) branch.ahead = Number(ahead[1]);
      if (behind) branch.behind = Number(behind[1]);
    }
    branches.push(branch);
  }
  return branches;
}

/* Service operations --------------------------------------------------------- */

async function isRepo(root: string): Promise<boolean> {
  const r = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

async function status(root: string): Promise<GitStatus> {
  const r = await runGit(root, ["status", "--porcelain=v2", "--branch", "-z"]);
  if (!r.ok) return emptyStatus();
  return parseStatus(r.stdout);
}

async function branches(root: string): Promise<GitBranch[]> {
  const r = await runGit(root, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads", "refs/remotes"]);
  if (!r.ok) return [];
  return parseBranches(r.stdout);
}

async function repoInfo(root: string): Promise<GitRepoInfo> {
  if (!(await isRepo(root))) {
    return { isRepo: false, root: null, branch: null, detached: false, ahead: 0, behind: 0, remotes: [] };
  }
  const [st, remotesR] = await Promise.all([status(root), runGit(root, ["remote"])]);
  return {
    isRepo: true,
    root,
    branch: st.branch,
    detached: st.detached,
    ahead: st.ahead,
    behind: st.behind,
    remotes: remotesR.ok ? remotesR.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [],
  };
}

async function checkout(root: string, name: string): Promise<GitResult> {
  return runGit(root, ["switch", name]);
}

/* Staging & commit ----------------------------------------------------------- */

async function stage(root: string, paths: string[]): Promise<GitResult> {
  if (paths.length === 0) return runGit(root, ["add", "-A"]);
  return runGit(root, ["add", "--", ...paths]);
}

async function unstage(root: string, paths: string[]): Promise<GitResult> {
  if (paths.length === 0) return runGit(root, ["reset", "-q"]);
  return runGit(root, ["restore", "--staged", "--", ...paths]);
}

/** Revert tracked paths to HEAD and remove untracked ones (best-effort, combined). */
async function discard(root: string, paths: string[]): Promise<GitResult> {
  if (paths.length === 0) return { ok: true, stdout: "", stderr: "", code: 0 };
  const restore = await runGit(root, ["restore", "--staged", "--worktree", "--", ...paths]);
  const clean = await runGit(root, ["clean", "-fd", "--", ...paths]);
  return { ok: restore.ok || clean.ok, stdout: `${restore.stdout}${clean.stdout}`, stderr: restore.ok ? clean.stderr : restore.stderr, code: restore.ok || clean.ok ? 0 : 1 };
}

async function commit(root: string, message: string, opts: { amend?: boolean } = {}): Promise<GitResult> {
  const args = ["commit", "-m", message];
  if (opts.amend) args.push("--amend");
  return runGit(root, args);
}

/* Sync ----------------------------------------------------------------------- */

async function fetch(root: string, remote?: string): Promise<GitResult> {
  return runGit(root, remote ? ["fetch", remote] : ["fetch", "--all"]);
}

async function pull(root: string, opts: { rebase?: boolean } = {}): Promise<GitResult> {
  return runGit(root, opts.rebase ? ["pull", "--rebase"] : ["pull"]);
}

async function push(root: string, opts: { setUpstream?: boolean; remote?: string } = {}): Promise<GitResult> {
  if (opts.setUpstream) {
    const info = await repoInfo(root);
    if (info.branch) return runGit(root, ["push", "-u", opts.remote ?? "origin", info.branch]);
  }
  return runGit(root, ["push"]);
}

/* Branches ------------------------------------------------------------------- */

async function createBranch(root: string, name: string, from?: string): Promise<GitResult> {
  return runGit(root, from ? ["switch", "-c", name, from] : ["switch", "-c", name]);
}

async function deleteBranch(root: string, name: string, force = false): Promise<GitResult> {
  return runGit(root, ["branch", force ? "-D" : "-d", name]);
}

/* History -------------------------------------------------------------------- */

// Unit separator between fields, record separator between commits (avoids -z clashes).
const LOG_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%P%x1e";

/** Parse `git log --format=<LOG_FORMAT>` output. */
export function parseLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of raw.split("\x1e")) {
    const line = record.replace(/^\n/, "");
    if (!line.trim()) continue;
    const [hash, shortHash, subject, author, authorEmail, date, parents] = line.split("\x1f");
    if (!hash) continue;
    commits.push({
      hash,
      shortHash: shortHash ?? "",
      subject: subject ?? "",
      author: author ?? "",
      authorEmail: authorEmail ?? "",
      date: date ?? "",
      parents: (parents ?? "").split(" ").filter(Boolean),
    });
  }
  return commits;
}

async function log(root: string, opts: { limit?: number; skip?: number; path?: string; ref?: string } = {}): Promise<GitCommit[]> {
  const args = ["log", `--format=${LOG_FORMAT}`, `--max-count=${opts.limit ?? 50}`];
  if (opts.skip) args.push(`--skip=${opts.skip}`);
  if (opts.ref) args.push(opts.ref);
  if (opts.path) args.push("--", opts.path);
  const r = await runGit(root, args);
  if (!r.ok) return [];
  return parseLog(r.stdout);
}

function nameStatusCode(token: string): GitFileStatus {
  return codeToStatus(token[0] ?? "M");
}

/** Parse `git diff-tree --name-status -z` NUL fields into file entries. */
export function parseNameStatus(z: string): GitFileEntry[] {
  const files: GitFileEntry[] = [];
  const fields = z.split("\0").filter((f) => f.length > 0);
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]!;
    if (code[0] === "R" || code[0] === "C") {
      const orig = fields[++i];
      const path = fields[++i];
      if (path) files.push({ path, orig, status: "renamed", staged: false });
    } else {
      const path = fields[++i];
      if (path) files.push({ path, status: nameStatusCode(code), staged: false });
    }
  }
  return files;
}

async function show(root: string, ref: string): Promise<GitCommitDetail> {
  const [meta] = await log(root, { limit: 1, ref });
  const filesR = await runGit(root, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", ref]);
  const files = filesR.ok ? parseNameStatus(filesR.stdout) : [];
  return {
    commit: meta ?? { hash: ref, shortHash: ref.slice(0, 7), subject: "", author: "", authorEmail: "", date: "", parents: [] },
    files,
  };
}

/* Diff ----------------------------------------------------------------------- */

async function showBlob(root: string, rev: string, path: string): Promise<{ content: string; binary: boolean }> {
  const r = await runGit(root, ["show", `${rev}:${path}`]);
  if (!r.ok) return { content: "", binary: false };
  const binary = r.stdout.includes("\0");
  return { content: binary ? "" : r.stdout, binary };
}

async function readWorkingFile(root: string, relPath: string): Promise<{ content: string; binary: boolean }> {
  try {
    const buf = await readFile(join(root, relPath));
    const binary = buf.includes(0);
    return { content: binary ? "" : buf.toString("utf8"), binary };
  } catch {
    return { content: "", binary: false };
  }
}

/** Before/after blobs for a file. "worktree"=index→disk, "staged"=HEAD→index, "head"=HEAD→disk. */
async function diffFile(root: string, path: string, mode: "worktree" | "staged" | "head"): Promise<GitFileDiff> {
  let before: { content: string; binary: boolean };
  let after: { content: string; binary: boolean };
  if (mode === "staged") {
    before = await showBlob(root, "HEAD", path);
    after = await showBlob(root, "", path);
  } else if (mode === "head") {
    before = await showBlob(root, "HEAD", path);
    after = await readWorkingFile(root, path);
  } else {
    before = await showBlob(root, "", path);
    after = await readWorkingFile(root, path);
  }
  return { path, before: before.content, after: after.content, binary: before.binary || after.binary };
}

/** Before/after blobs for a file at a commit vs its first parent (history viewer). */
async function diffCommit(root: string, ref: string, path: string): Promise<GitFileDiff> {
  const before = await showBlob(root, `${ref}~1`, path);
  const after = await showBlob(root, ref, path);
  return { path, before: before.content, after: after.content, binary: before.binary || after.binary };
}

/* Blame ---------------------------------------------------------------------- */

/** Parse `git blame --line-porcelain` output. */
export function parseBlame(raw: string): GitBlameLine[] {
  const lines: GitBlameLine[] = [];
  let cur: Partial<GitBlameLine> = {};
  for (const line of raw.split("\n")) {
    const header = /^([0-9a-f]{7,40}) \d+ (\d+)/.exec(line);
    if (header) {
      cur = { hash: header[1]!.slice(0, 8), line: Number(header[2]) };
    } else if (line.startsWith("author ")) {
      cur.author = line.slice("author ".length);
    } else if (line.startsWith("author-time ")) {
      cur.date = new Date(Number(line.slice("author-time ".length)) * 1000).toISOString();
    } else if (line.startsWith("summary ")) {
      cur.summary = line.slice("summary ".length);
    } else if (line.startsWith("\t")) {
      lines.push({
        line: cur.line ?? lines.length + 1,
        hash: cur.hash ?? "",
        author: cur.author ?? "",
        date: cur.date ?? "",
        summary: cur.summary ?? "",
        content: line.slice(1),
      });
    }
  }
  return lines;
}

async function blame(root: string, path: string): Promise<GitBlameLine[]> {
  const r = await runGit(root, ["blame", "--line-porcelain", "--", path]);
  if (!r.ok) return [];
  return parseBlame(r.stdout);
}

/* Remotes -------------------------------------------------------------------- */

/** Parse `git remote -v` output into unique remotes. */
export function parseRemotes(raw: string): GitRemote[] {
  const byName = new Map<string, GitRemote>();
  for (const line of raw.split("\n")) {
    const m = /^(\S+)\t(\S+)\s+\((fetch|push)\)/.exec(line);
    if (!m) continue;
    const [, name, url, kind] = m;
    const entry = byName.get(name!) ?? { name: name!, fetchUrl: "", pushUrl: "" };
    if (kind === "fetch") entry.fetchUrl = url!;
    else entry.pushUrl = url!;
    byName.set(name!, entry);
  }
  return [...byName.values()];
}

async function remotes(root: string): Promise<GitRemote[]> {
  const r = await runGit(root, ["remote", "-v"]);
  if (!r.ok) return [];
  return parseRemotes(r.stdout);
}

/* Stash ---------------------------------------------------------------------- */

/** Parse `git stash list --format=%gd%x1f%s`. */
export function parseStash(raw: string): GitStash[] {
  const stashes: GitStash[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [ref, message] = line.split("\x1f");
    const m = /stash@\{(\d+)\}/.exec(ref ?? "");
    if (!m) continue;
    stashes.push({ index: Number(m[1]), message: message ?? "" });
  }
  return stashes;
}

async function stashList(root: string): Promise<GitStash[]> {
  const r = await runGit(root, ["stash", "list", "--format=%gd%x1f%s"]);
  if (!r.ok) return [];
  return parseStash(r.stdout);
}

async function stashPush(root: string, message?: string, includeUntracked = false): Promise<GitResult> {
  const args = ["stash", "push"];
  if (includeUntracked) args.push("-u");
  if (message) args.push("-m", message);
  return runGit(root, args);
}

async function stashPop(root: string, index = 0): Promise<GitResult> {
  return runGit(root, ["stash", "pop", `stash@{${index}}`]);
}

async function stashDrop(root: string, index: number): Promise<GitResult> {
  return runGit(root, ["stash", "drop", `stash@{${index}}`]);
}

/** The git service surface. Both the desktop host and agent-core tools import this. */
export const git = {
  isRepo,
  status,
  branches,
  repoInfo,
  checkout,
  stage,
  unstage,
  discard,
  commit,
  fetch,
  pull,
  push,
  createBranch,
  deleteBranch,
  log,
  show,
  diffFile,
  diffCommit,
  blame,
  remotes,
  stashList,
  stashPush,
  stashPop,
  stashDrop,
};

/* Change watcher ------------------------------------------------------------- */

/**
 * Fires `onChange` (debounced) when `.git` HEAD/index/refs mutate — catching git
 * activity from the terminal or agent. Best-effort: fs.watch over the `\\wsl$` 9P
 * mount is unreliable, so hosts also refresh manually after their own operations.
 */
export class GitWatcher {
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly debounceMs = 250,
  ) {}

  watch(root: string | null): void {
    this.stop();
    if (!root) return;
    const gitDir = join(root, ".git");
    for (const dir of [gitDir, join(gitDir, "refs")]) {
      try {
        const w = watch(dir, { recursive: false }, () => this.fire());
        w.on("error", () => undefined);
        this.watchers.push(w);
      } catch {
        // Missing .git, a .git file (worktree/submodule), or a 9P mount: skip.
      }
    }
  }

  private fire(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, this.debounceMs);
  }

  stop(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    this.watchers = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
