import { spawn } from "node:child_process";
import type { ToolDefinition } from "../types.js";
import { asString } from "./util.js";

function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: process.env, windowsHide: true });
    let output = "";
    child.stdout.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.on("close", (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

export const enterWorktreeTool: ToolDefinition = {
  name: "enter_worktree",
  description: "Create a git worktree for isolated work. Returns the worktree path.",
  tier: "execute",
  parameters: {
    type: "object",
    properties: {
      branch: { type: "string", description: "Branch name for the worktree." },
      path: { type: "string", description: "Relative path for the new worktree directory." },
    },
    required: ["branch", "path"],
  },
  summarize: (args) => `worktree ${String(args.branch ?? "")}`,
  async execute(args, ctx): Promise<string> {
    const branch = asString(args.branch, "branch");
    const relPath = asString(args.path, "path");
    const result = await runGit(ctx.cwd, ["worktree", "add", relPath, "-b", branch]);
    if (!result.ok) return `ERROR creating worktree: ${result.output}`;
    return `Worktree created at ${relPath} on branch ${branch}.\n${result.output}`;
  },
};

export const exitWorktreeTool: ToolDefinition = {
  name: "exit_worktree",
  description: "Remove a git worktree. Set force=true to discard uncommitted changes.",
  tier: "execute",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Worktree path to remove." },
      force: { type: "boolean", description: "Force removal even with dirty files." },
    },
    required: ["path"],
  },
  summarize: (args) => `remove worktree ${String(args.path ?? "")}`,
  async execute(args, ctx): Promise<string> {
    const relPath = asString(args.path, "path");
    const gitArgs = ["worktree", "remove", relPath];
    if (args.force === true) gitArgs.push("--force");
    const result = await runGit(ctx.cwd, gitArgs);
    if (!result.ok) return `ERROR removing worktree: ${result.output}`;
    return `Worktree removed: ${relPath}\n${result.output}`;
  },
};
