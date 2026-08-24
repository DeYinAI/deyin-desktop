import type {
  GitBlameLine,
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitFileDiff,
  GitRemote,
  GitRepoInfo,
  GitResultLite,
  GitStash,
  GitStatus,
} from "../types.js";
import { shellQuote } from "./remote-paths.js";

export interface RemoteExec {
  (command: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** Run git on a remote machine via SSH exec. */
export class RemoteGitService {
  constructor(
    private readonly exec: RemoteExec,
    private readonly root: string,
  ) {}

  private gitCmd(args: string): string {
    return `git -C ${shellQuote(this.root)} ${args}`;
  }

  private async run(args: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const r = await this.exec(this.gitCmd(args));
    return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
  }

  async repoInfo(): Promise<GitRepoInfo> {
    const inside = await this.run("rev-parse --is-inside-work-tree");
    if (!inside.ok) {
      return { isRepo: false, root: this.root, branch: null, detached: false, ahead: 0, behind: 0, remotes: [] };
    }
    const branchR = await this.run("symbolic-ref --short HEAD");
    const branch = branchR.ok ? branchR.stdout.trim() || null : null;
    return {
      isRepo: true,
      root: this.root,
      branch,
      detached: !branchR.ok,
      ahead: 0,
      behind: 0,
      remotes: [],
    };
  }

  async status(): Promise<GitStatus> {
    const branchR = await this.run("symbolic-ref --short HEAD");
    return {
      branch: branchR.ok ? branchR.stdout.trim() || null : null,
      detached: !branchR.ok,
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
    };
  }

  async branches(): Promise<GitBranch[]> {
    const r = await this.run("branch -a --format=%(refname:short)");
    if (!r.ok) return [];
    return r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name, current: false, remote: name.includes("/") }));
  }

  async checkout(name: string): Promise<GitResultLite> {
    const r = await this.run(`switch ${shellQuote(name)}`);
    return { ok: r.ok, message: (r.ok ? r.stdout : r.stderr).trim() || (r.ok ? `Switched to ${name}` : "git failed") };
  }

  async stage(_paths: string[]): Promise<GitResultLite> {
    const r = await this.run("add -A");
    return { ok: r.ok, message: r.ok ? "Staged" : r.stderr.trim() };
  }

  async unstage(_paths: string[]): Promise<GitResultLite> {
    const r = await this.run("reset HEAD");
    return { ok: r.ok, message: r.ok ? "Unstaged" : r.stderr.trim() };
  }

  async discard(_paths: string[]): Promise<GitResultLite> {
    const r = await this.run("checkout -- .");
    return { ok: r.ok, message: r.ok ? "Discarded" : r.stderr.trim() };
  }

  async commit(message: string): Promise<GitResultLite> {
    const r = await this.run(`commit -m ${shellQuote(message)}`);
    return { ok: r.ok, message: r.ok ? "Committed" : r.stderr.trim() };
  }

  async fetch(): Promise<GitResultLite> {
    const r = await this.run("fetch");
    return { ok: r.ok, message: r.ok ? "Fetched" : r.stderr.trim() };
  }

  async pull(): Promise<GitResultLite> {
    const r = await this.run("pull");
    return { ok: r.ok, message: r.ok ? "Pulled" : r.stderr.trim() };
  }

  async push(): Promise<GitResultLite> {
    const r = await this.run("push");
    return { ok: r.ok, message: r.ok ? "Pushed" : r.stderr.trim() };
  }

  async log(): Promise<GitCommit[]> {
    return [];
  }

  async show(_ref: string): Promise<GitCommitDetail> {
    return {
      commit: { hash: "", shortHash: "", subject: "", author: "", authorEmail: "", date: "", parents: [] },
      files: [],
    };
  }

  async diffFile(path: string): Promise<GitFileDiff> {
    return { path, before: "", after: "", binary: false };
  }

  async blame(_path: string): Promise<GitBlameLine[]> {
    return [];
  }

  async remotes(): Promise<GitRemote[]> {
    return [];
  }

  async stashList(): Promise<GitStash[]> {
    return [];
  }
}
