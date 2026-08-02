import { spawn } from "node:child_process";
import type { GitBranch, GitFileStatus, GitLogEntry, GitStatus } from "../types.js";

export type { GitBranch, GitFileStatus, GitLogEntry, GitStatus };

const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

function assertSafeBranch(branch: string): void {
  const trimmed = branch.trim();
  if (!trimmed || trimmed.startsWith("-") || !SAFE_BRANCH_RE.test(trimmed)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `git ${args.join(" ")} exited ${code}`));
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const branchOut = await runGit(cwd, ["branch", "--show-current"]).catch(() => "");
  const branch = branchOut.trim() || "HEAD";
  let ahead = 0;
  let behind = 0;
  try {
    const ab = await runGit(cwd, ["rev-list", "--left-right", "--count", `${branch}...@{upstream}`]);
    const [a, b] = ab.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    ahead = Number.isFinite(a) ? a! : 0;
    behind = Number.isFinite(b) ? b! : 0;
  } catch {
    // no upstream
  }
  const porcelain = await runGit(cwd, ["status", "--porcelain=2", "--branch"]);
  const files: GitFileStatus[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("1 ") && !line.startsWith("2 ")) continue;
    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    const path = parts.slice(8).join(" ") || parts[parts.length - 1] || "";
    const index = xy[0] ?? ".";
    const workTree = xy[1] ?? ".";
    if (path) files.push({ path, index, workTree });
  }
  return { branch, ahead, behind, files };
}

export async function gitDiff(cwd: string, path?: string, staged = false): Promise<string> {
  const args = ["diff"];
  if (staged) args.push("--cached");
  if (path) args.push("--", path);
  return runGit(cwd, args);
}

export async function gitStage(cwd: string, paths: string[], unstage = false): Promise<void> {
  if (paths.length === 0) return;
  const args = unstage ? ["reset", "HEAD", "--", ...paths] : ["add", "--", ...paths];
  await runGit(cwd, args);
}

export async function gitCommit(cwd: string, message: string): Promise<string> {
  return runGit(cwd, ["commit", "-m", message]);
}

export async function gitBranches(cwd: string): Promise<GitBranch[]> {
  const out = await runGit(cwd, ["branch", "--format=%(refname:short)\t%(HEAD)"]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, head] = line.split("\t");
      return { name: name ?? line, current: head === "*" };
    });
}

export async function gitCheckout(cwd: string, branch: string): Promise<void> {
  assertSafeBranch(branch);
  await runGit(cwd, ["checkout", branch]);
}

export async function gitLog(cwd: string, limit = 20): Promise<GitLogEntry[]> {
  const out = await runGit(cwd, [
    "log",
    `-n`,
    String(limit),
    `--pretty=format:%H%x00%s%x00%an%x00%ad`,
    `--date=short`,
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, date] = line.split("\0");
      return { hash: hash ?? "", subject: subject ?? "", author: author ?? "", date: date ?? "" };
    });
}
