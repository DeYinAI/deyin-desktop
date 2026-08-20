import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, runGit, type GitResult, type GitStatus } from "@deyin/host-core";

export interface RepoConnectOptions {
  url: string;
  /** Optional access token for private repos (kept in memory, never persisted). */
  token?: string;
  /** Existing branch to resume (reconnect); omit to create a fresh work branch. */
  branch?: string;
}

export interface RepoState {
  connected: boolean;
  url: string | null;
  branch: string | null;
  defaultBranch: string | null;
}

export interface RepoShipResult {
  ok: boolean;
  /** True when the work branch was merged into the default branch and pushed. */
  merged: boolean;
  branch: string;
  defaultBranch: string;
  /** Commit subjects shipped with this merge (base..branch). */
  commits: string[];
  message: string;
  /** Compare URL offered when direct push/merge is not possible. */
  prUrl: string | null;
}

/** Strip scheme-embedded credentials so a URL is safe to echo back to the client. */
function sanitizeRemoteUrl(url: string): string {
  return url.replace(/^(https?:\/\/)([^/@\s]+)@/i, "$1").trim();
}

function slugifyRepo(url: string): string {
  const tail = url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[\/:]/).pop() ?? "repo";
  return (
    tail
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "repo"
  );
}

/** GitHub compare URL for a remote, or null for non-GitHub hosts. */
export function compareUrlFor(remote: string, base: string, branch: string): string | null {
  const m = /^(?:https?:\/\/[^\/]*github\.com[/:]|git@github\.com:)([^\/]+)\/([^#?]+?)(?:\.git)?$/i.exec(remote.trim());
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/compare/${base}...${branch}?expand=1`;
}

function isDirty(status: GitStatus): boolean {
  return status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length > 0;
}

/**
 * Git-backed task workflow for one web session: clone a remote into the sandbox,
 * keep all work on a dedicated branch, and ship via commit → push → merge.
 * The access token lives only in this instance and is passed to git via
 * `http.extraheader` (never written to the repo config or the journal).
 */
export class RepoManager {
  private token: string | null = null;
  private url: string | null = null;
  private branchName: string | null = null;
  private defaultBranch: string | null = null;

  constructor(
    private readonly root: string,
    private readonly committer: { name?: string; email?: string },
    private readonly progress: (stage: "clone" | "connect" | "ship", line: string) => void,
  ) {}

  state(): RepoState {
    return {
      connected: Boolean(this.url),
      url: this.url,
      branch: this.branchName,
      defaultBranch: this.defaultBranch,
    };
  }

  /** Branch info for the agent system prompt. */
  branchInfo(): { branch: string; defaultBranch: string } | null {
    if (!this.url || !this.branchName) return null;
    return { branch: this.branchName, defaultBranch: this.defaultBranch ?? "main" };
  }

  /** `-c http.extraheader=…` args carrying the access token (empty without one). */
  authArgs(): string[] {
    if (!this.token) return [];
    const basic = Buffer.from(`x-access-token:${this.token}`).toString("base64");
    return ["-c", `http.extraheader=Authorization: Basic ${basic}`];
  }

  private async git(args: string[]): Promise<GitResult> {
    return runGit(this.root, [...this.authArgs(), ...args]);
  }

  async connect(opts: RepoConnectOptions): Promise<RepoState> {
    const url = sanitizeRemoteUrl(opts.url);
    if (!url) throw new Error("Repository URL is required.");
    if (existsSync(join(this.root, ".git"))) {
      const remoteR = await runGit(this.root, ["remote", "get-url", "origin"]);
      const current = remoteR.ok ? sanitizeRemoteUrl(remoteR.stdout.trim()) : null;
      if (current && current !== url) {
        throw new Error(`This session is already connected to ${current}. Reload the page to start a fresh session.`);
      }
      this.url = url;
      this.token = opts.token ?? null;
      this.progress("connect", `Fetching ${url}…`);
      const fetchR = await this.git(["fetch", "origin", "--prune"]);
      if (!fetchR.ok) throw new Error(`git fetch failed: ${fetchR.stderr.trim() || "unknown error"}`);
      this.defaultBranch = (await this.detectDefaultBranch()) ?? this.defaultBranch;
      this.branchName = opts.branch
        ? await this.resumeBranch(opts.branch)
        : await this.createWorkBranch();
      return this.state();
    }

    this.progress("clone", `Cloning ${url}…`);
    await this.clone(url);
    this.url = url;
    this.token = opts.token ?? null;

    // Repo-local identity so commits never depend on the server's global config.
    await runGit(this.root, ["config", "user.name", this.committer.name?.trim() || "Deyin Agent"]);
    await runGit(this.root, ["config", "user.email", this.committer.email?.trim() || "deyin@users.noreply.github.com"]);

    this.defaultBranch = await this.detectDefaultBranch();
    this.branchName = opts.branch ? await this.resumeBranch(opts.branch) : await this.createWorkBranch();
    return this.state();
  }

  /** `git clone --progress` with stderr streamed to the progress callback. */
  private clone(url: string): Promise<void> {
    const args = ["-C", this.root, ...this.authArgs(), "clone", "--progress", url, "."];
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      let stderr = "";
      let last = "";
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
        const chunk = d.toString("utf8");
        last = chunk;
        for (const line of chunk.split(/[\r\n]+/)) {
          if (line.trim()) this.progress("clone", line.trim());
        }
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git clone failed: ${(stderr || last).trim() || `exit ${code}`}`));
      });
    });
  }

  private async detectDefaultBranch(): Promise<string | null> {
    const head = await runGit(this.root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (head.ok) return head.stdout.trim().replace(/^origin\//, "") || null;
    const local = await runGit(this.root, ["symbolic-ref", "--short", "HEAD"]);
    return local.ok ? local.stdout.trim() || null : null;
  }

  /** Switch to an existing branch (local, or created tracking its origin counterpart). */
  private async resumeBranch(branch: string): Promise<string> {
    this.progress("connect", `Checking out ${branch}…`);
    let r = await this.git(["switch", branch]);
    if (!r.ok) r = await this.git(["switch", "-c", branch, `origin/${branch}`]);
    if (!r.ok) throw new Error(`Branch "${branch}" was not found on the remote.`);
    return branch;
  }

  private async createWorkBranch(): Promise<string> {
    const name = `deyin/${slugifyRepo(this.url ?? "repo")}-${randomBytes(2).toString("hex")}`;
    const r = await this.git(["switch", "-c", name]);
    if (!r.ok) throw new Error(`Failed to create work branch: ${r.stderr.trim()}`);
    this.progress("connect", `Working on branch ${name}`);
    return name;
  }

  /**
   * Ship the task: commit any leftovers on the work branch, push it, merge it
   * into the default branch and push that. Falls back to a compare ("open PR")
   * URL whenever a push or the merge is rejected.
   */
  async ship(message?: string): Promise<RepoShipResult> {
    if (!this.url) throw new Error("No repository connected.");
    const branch = this.branchName ?? (await this.currentBranch()) ?? "HEAD";
    const base = this.defaultBranch ?? "main";
    const prUrl = compareUrlFor(this.url, base, branch);
    const fail = (merged: boolean, msg: string): RepoShipResult => ({
      ok: false,
      merged,
      branch,
      defaultBranch: base,
      commits: [],
      message: msg,
      prUrl,
    });

    // 1. Commit leftovers the agent left uncommitted.
    const status = await git.status(this.root);
    if (isDirty(status)) {
      this.progress("ship", "Committing remaining changes…");
      await git.stage(this.root, []);
      const commitR = await this.git(["commit", "-m", message?.trim() || "deyin: task changes"]);
      if (!commitR.ok) return fail(false, `Commit failed: ${commitR.stderr.trim()}`);
    }

    // 2. Commit subjects riding along (base..branch).
    const subjectsR = await runGit(this.root, ["log", "--format=%s", `${base}..${branch}`]);
    const commits = subjectsR.ok ? subjectsR.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];

    // 3. Push the work branch.
    this.progress("ship", `Pushing ${branch}…`);
    const pushR = await this.git(["push", "-u", "origin", branch]);
    if (!pushR.ok) {
      return fail(
        false,
        `Could not push ${branch}: ${pushR.stderr.trim() || "push rejected"}. Open a pull request instead.`,
      );
    }

    // 4. Merge into the default branch and push it.
    this.progress("ship", `Merging ${branch} into ${base}…`);
    const switchR = await this.git(["switch", base]);
    if (!switchR.ok) return fail(false, `Could not switch to ${base}: ${switchR.stderr.trim()}`);
    const mergeR = await this.git(["merge", "--no-ff", branch, "-m", `Merge ${branch} into ${base}`]);
    if (!mergeR.ok) {
      await this.git(["merge", "--abort"]);
      await this.git(["switch", branch]);
      return fail(false, `Merge into ${base} conflicted: ${mergeR.stderr.trim()}. Resolve locally or open a pull request.`);
    }
    const pushBaseR = await this.git(["push", "origin", base]);
    await this.git(["switch", branch]); // resume work on the task branch
    if (!pushBaseR.ok) {
      return fail(false, `Merged locally but pushing ${base} was rejected: ${pushBaseR.stderr.trim()}. Open a pull request instead.`);
    }

    return { ok: true, merged: true, branch, defaultBranch: base, commits, message: `Merged ${branch} into ${base}`, prUrl: null };
  }

  private async currentBranch(): Promise<string | null> {
    const r = await runGit(this.root, ["symbolic-ref", "--short", "HEAD"]);
    return r.ok ? r.stdout.trim() || null : null;
  }
}
