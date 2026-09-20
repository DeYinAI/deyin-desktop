import { git, runGit } from "@deyin/host-core";
import type { ToolDefinition } from "../types.js";
import { asString } from "./util.js";

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
    if (!(await git.isRepo(ctx.cwd))) {
      return "ERROR: Not a git repository (or any of the parent directories). Cannot create a worktree outside a git repository.";
    }
    const branch = asString(args.branch, "branch");
    const relPath = asString(args.path, "path");
    const result = await runGit(ctx.cwd, ["worktree", "add", relPath, "-b", branch]);
    const rawOut = (result.stdout || result.stderr).trim();
    if (!result.ok) {
      const cleanErr = rawOut.replace(/^fatal:\s*/i, "").trim();
      return `ERROR creating worktree: ${cleanErr || rawOut}`;
    }
    return `Worktree created at ${relPath} on branch ${branch}.${rawOut ? `\n${rawOut}` : ""}`;
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
    if (!(await git.isRepo(ctx.cwd))) {
      return "ERROR: Not a git repository (or any of the parent directories). Cannot remove a worktree outside a git repository.";
    }
    const relPath = asString(args.path, "path");
    const gitArgs = ["worktree", "remove", relPath];
    if (args.force === true) gitArgs.push("--force");
    const result = await runGit(ctx.cwd, gitArgs);
    const rawOut = (result.stdout || result.stderr).trim();
    if (!result.ok) {
      const cleanErr = rawOut.replace(/^fatal:\s*/i, "").trim();
      return `ERROR removing worktree: ${cleanErr || rawOut}`;
    }
    return `Worktree removed: ${relPath}${rawOut ? `\n${rawOut}` : ""}`;
  },
};
