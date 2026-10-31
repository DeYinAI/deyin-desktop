/** The git workspace: a managed clone (or the user's checkout) with one worktree per ticket. */
import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Logger, PrepareInput, Workspace } from "./ports.js";

const GIT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

export type GitRunner = (args: readonly string[], options: { cwd?: string; env: Readonly<Record<string, string>>; signal?: AbortSignal }) => Promise<string>;

/** Runs the git binary; a failure carries git's own message, which never contains the token (it travels in the environment). */
export const runGit: GitRunner = (args, { cwd, env, signal }) =>
  new Promise((resolveOutput, reject) => {
    execFile("git", [...args], { cwd, env: { ...process.env, ...env }, signal, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0] ?? ""} failed: ${(stderr || error.message).trim().split("\n").slice(-3).join(" ")}`));
      else resolveOutput(stdout.trim());
    });
  });

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

export interface GitWorkspaceOptions {
  /** Where managed clones live: `<root>/<owner>__<name>`. */
  root: string;
  /** The root every ticket directory must be inside, so a worktree never lands elsewhere; read on each use, as the setting can change. */
  ticketsRoot(): string;
  logger: Logger;
  git?: GitRunner;
  /** Where a repository is cloned from; GitHub over https unless a test or a mirror says otherwise. */
  remoteUrl?: (repository: string) => string;
}

export class GitWorkspace implements Workspace {
  private readonly git: GitRunner;
  /** Serializes work on one repository: git locks its own metadata, and concurrent prepares would collide on it. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: GitWorkspaceOptions) {
    this.git = options.git ?? runGit;
  }

  /** The directory a repository is cloned to when no checkout is configured. */
  managedClone(repository: string): string {
    return join(this.options.root, repository.replace("/", "__"));
  }

  private exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(run, run);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }

  private assertInside(directory: string): string {
    const target = resolve(directory);
    const inside = relative(resolve(this.options.ticketsRoot()), target);
    if (inside === "" || inside.startsWith("..") || inside.split(sep).includes("..")) throw new Error(`${directory} is outside the tickets directory`);
    return target;
  }

  async prepare(input: PrepareInput): Promise<void> {
    const directory = this.assertInside(input.directory);
    const repo = input.checkout || this.managedClone(input.repository);
    await this.exclusive(repo, async () => {
      const options = { env: input.env, ...(input.signal ? { signal: input.signal } : {}) };
      if (await exists(join(directory, ".git"))) return;
      if (!(await exists(join(repo, ".git")))) {
        if (input.checkout) throw new Error(`${input.checkout} is not a git checkout`);
        await mkdir(dirname(repo), { recursive: true });
        await this.git(["clone", "--no-tags", (this.options.remoteUrl ?? ((name) => `https://github.com/${name}.git`))(input.repository), repo], options);
      }
      await this.git(["fetch", "--prune", "origin"], { ...options, cwd: repo });
      await this.git(["worktree", "prune"], { ...options, cwd: repo });
      const base = await this.defaultBranch(repo, options);
      await mkdir(dirname(directory), { recursive: true });
      const local = await this.git(["branch", "--list", input.branch], { ...options, cwd: repo });
      const remote = await this.git(["branch", "--remotes", "--list", `origin/${input.branch}`], { ...options, cwd: repo });
      if (local) await this.git(["worktree", "add", directory, input.branch], { ...options, cwd: repo });
      else if (remote) await this.git(["worktree", "add", "-b", input.branch, directory, `origin/${input.branch}`], { ...options, cwd: repo });
      else await this.git(["worktree", "add", "-b", input.branch, directory, base], { ...options, cwd: repo });
      this.options.logger.info(`superagent prepared ${input.name} on ${input.branch}`);
    });
  }

  /** The remote's default branch as a ref, such as origin/main. */
  private async defaultBranch(repo: string, options: { env: Readonly<Record<string, string>>; signal?: AbortSignal }): Promise<string> {
    const read = () => this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { ...options, cwd: repo });
    try {
      return await read();
    } catch {
      await this.git(["remote", "set-head", "origin", "--auto"], { ...options, cwd: repo });
      return read();
    }
  }

  async remove({ directory }: { directory: string }): Promise<void> {
    const target = this.assertInside(directory);
    try {
      await this.git(["worktree", "remove", "--force", target], { cwd: target, env: {} });
    } catch {
      // The worktree is gone or git cannot find its repository; deleting the directory is all that is left to do.
    }
    await rm(target, { recursive: true, force: true });
  }
}
