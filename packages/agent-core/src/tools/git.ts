import { git, runGit, type GitStatus } from "@deyin/host-core";
import type { ToolDefinition } from "../types.js";
import { asOptionalString, asString, truncate } from "./util.js";

/**
 * Dedicated git tools for the agent, backed by the same host-core git service the
 * desktop UI uses (so actions route correctly on WSL2 and show up in the panel).
 * Read-tier tools stay available in plan/ask modes; execute-tier tools are gated.
 */

function toPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim() && value.trim() !== ".") return [value.trim()];
  return [];
}

function renderStatus(s: GitStatus): string {
  const head = `On ${s.detached ? "detached HEAD" : `branch ${s.branch ?? "?"}`}${s.upstream ? ` (tracking ${s.upstream})` : ""}; ahead ${s.ahead}, behind ${s.behind}.`;
  const section = (title: string, files: GitStatus["staged"]): string =>
    files.length ? `\n${title}:\n${files.map((f) => `  ${(f.status[0] ?? "?").toUpperCase()} ${f.orig ? `${f.orig} -> ` : ""}${f.path}`).join("\n")}` : "";
  const body =
    section("Staged", s.staged) + section("Unstaged", s.unstaged) + section("Untracked", s.untracked) + section("Conflicts", s.conflicts);
  return `${head}${body || "\nWorking tree clean."}`;
}

export const gitStatusTool: ToolDefinition = {
  name: "git_status",
  description: "Show the working-tree status: current branch, ahead/behind, and staged/unstaged/untracked files.",
  tier: "read",
  parameters: { type: "object", properties: {} },
  summarize: () => "git status",
  async execute(_args, ctx): Promise<string> {
    return renderStatus(await git.status(ctx.cwd));
  },
};

export const gitLogTool: ToolDefinition = {
  name: "git_log",
  description: "Show recent commit history (hash, subject, author, date).",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max commits (default 20)." },
      path: { type: "string", description: "Limit history to a file/directory." },
    },
  },
  summarize: (args) => `git log${args.path ? ` ${String(args.path)}` : ""}`,
  async execute(args, ctx): Promise<string> {
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const commits = await git.log(ctx.cwd, { limit, path: asOptionalString(args.path) });
    if (commits.length === 0) return "No commits.";
    return commits.map((c) => `${c.shortHash} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`).join("\n");
  },
};

export const gitDiffTool: ToolDefinition = {
  name: "git_diff",
  description: "Show a unified diff of changes. Set staged=true for the index; pass a path to limit it.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Diff the staged index instead of the working tree." },
      path: { type: "string", description: "Limit the diff to this path." },
    },
  },
  summarize: (args) => `git diff${args.staged ? " --staged" : ""}${args.path ? ` ${String(args.path)}` : ""}`,
  async execute(args, ctx): Promise<string> {
    const gitArgs = ["diff"];
    if (args.staged === true) gitArgs.push("--staged");
    const path = asOptionalString(args.path);
    if (path) gitArgs.push("--", path);
    const r = await runGit(ctx.cwd, gitArgs, { signal: ctx.signal });
    return truncate(r.stdout.trim() || "(no changes)");
  },
};

export const gitBlameTool: ToolDefinition = {
  name: "git_blame",
  description: "Show, for each line of a file, the commit and author that last changed it.",
  tier: "read",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "File to blame." } },
    required: ["path"],
  },
  summarize: (args) => `git blame ${String(args.path ?? "")}`,
  async execute(args, ctx): Promise<string> {
    const path = asString(args.path, "path");
    const lines = await git.blame(ctx.cwd, path);
    if (lines.length === 0) return `No blame for ${path}.`;
    return truncate(lines.map((l) => `${l.hash.slice(0, 8)} ${l.author.padEnd(16).slice(0, 16)} ${l.line}: ${l.content}`).join("\n"));
  },
};

export const gitAddTool: ToolDefinition = {
  name: "git_add",
  description: 'Stage files for commit. Pass paths (array or string), or "." to stage everything.',
  tier: "execute",
  parameters: {
    type: "object",
    properties: { paths: { description: 'Paths to stage, or "." for all.' } },
    required: ["paths"],
  },
  summarize: (args) => `git add ${Array.isArray(args.paths) ? args.paths.join(" ") : String(args.paths ?? ".")}`,
  async execute(args, ctx): Promise<string> {
    const r = await git.stage(ctx.cwd, toPaths(args.paths));
    return r.ok ? "Staged." : `ERROR: ${r.stderr.trim() || "git add failed"}`;
  },
};

export const gitCommitTool: ToolDefinition = {
  name: "git_commit",
  description: "Commit the staged changes with a message.",
  tier: "execute",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message." },
      amend: { type: "boolean", description: "Amend the previous commit." },
    },
    required: ["message"],
  },
  summarize: (args) => `commit "${String(args.message ?? "").split("\n")[0]?.slice(0, 60)}"`,
  async execute(args, ctx): Promise<string> {
    const message = asString(args.message, "message");
    const r = await git.commit(ctx.cwd, message, { amend: args.amend === true });
    return r.ok ? truncate(r.stdout.trim() || "Committed.") : `ERROR: ${r.stderr.trim() || "git commit failed"}`;
  },
};

export const gitBranchTool: ToolDefinition = {
  name: "git_branch",
  description: "Manage branches: list, create, checkout, or delete.",
  tier: "execute",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", description: '"list" | "create" | "checkout" | "delete".' },
      name: { type: "string", description: "Branch name (for create/checkout/delete)." },
      from: { type: "string", description: "Base ref for create." },
      force: { type: "boolean", description: "Force delete." },
    },
    required: ["mode"],
  },
  summarize: (args) => `git branch ${String(args.mode ?? "")}${args.name ? ` ${String(args.name)}` : ""}`,
  async execute(args, ctx): Promise<string> {
    const mode = asString(args.mode, "mode");
    if (mode === "list") {
      const branches = await git.branches(ctx.cwd);
      return branches.map((b) => `${b.current ? "* " : "  "}${b.name}${b.remote ? " (remote)" : ""}`).join("\n") || "No branches.";
    }
    const name = asString(args.name, "name");
    const r =
      mode === "create"
        ? await git.createBranch(ctx.cwd, name, asOptionalString(args.from))
        : mode === "checkout"
          ? await git.checkout(ctx.cwd, name)
          : mode === "delete"
            ? await git.deleteBranch(ctx.cwd, name, args.force === true)
            : { ok: false, stdout: "", stderr: `Unknown mode "${mode}"`, code: 1 };
    return r.ok ? truncate(r.stdout.trim() || `${mode} ${name} done.`) : `ERROR: ${r.stderr.trim() || "git branch failed"}`;
  },
};

export const gitStashTool: ToolDefinition = {
  name: "git_stash",
  description: "Stash management: push, pop, list, or drop.",
  tier: "execute",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", description: '"push" | "pop" | "list" | "drop".' },
      message: { type: "string", description: "Message (for push)." },
      index: { type: "number", description: "Stash index (for pop/drop)." },
      include_untracked: { type: "boolean", description: "Include untracked files (for push)." },
    },
    required: ["mode"],
  },
  summarize: (args) => `git stash ${String(args.mode ?? "")}`,
  async execute(args, ctx): Promise<string> {
    const mode = asString(args.mode, "mode");
    if (mode === "list") {
      const stashes = await git.stashList(ctx.cwd);
      return stashes.map((s) => `stash@{${s.index}}: ${s.message}`).join("\n") || "No stashes.";
    }
    const index = typeof args.index === "number" ? args.index : 0;
    const r =
      mode === "push"
        ? await git.stashPush(ctx.cwd, asOptionalString(args.message), args.include_untracked === true)
        : mode === "pop"
          ? await git.stashPop(ctx.cwd, index)
          : mode === "drop"
            ? await git.stashDrop(ctx.cwd, index)
            : { ok: false, stdout: "", stderr: `Unknown mode "${mode}"`, code: 1 };
    return r.ok ? truncate(r.stdout.trim() || `stash ${mode} done.`) : `ERROR: ${r.stderr.trim() || "git stash failed"}`;
  },
};

export const gitFetchTool: ToolDefinition = {
  name: "git_fetch",
  description: "Fetch updates from all remotes.",
  tier: "execute",
  parameters: { type: "object", properties: {} },
  summarize: () => "git fetch",
  async execute(_args, ctx): Promise<string> {
    const r = await git.fetch(ctx.cwd);
    return r.ok ? truncate(`${r.stdout}${r.stderr}`.trim() || "Fetched.") : `ERROR: ${r.stderr.trim() || "git fetch failed"}`;
  },
};

export const gitPullTool: ToolDefinition = {
  name: "git_pull",
  description: "Pull from the upstream branch. Set rebase=true to rebase.",
  tier: "execute",
  parameters: { type: "object", properties: { rebase: { type: "boolean" } } },
  summarize: (args) => `git pull${args.rebase ? " --rebase" : ""}`,
  async execute(args, ctx): Promise<string> {
    const r = await git.pull(ctx.cwd, { rebase: args.rebase === true });
    return r.ok ? truncate(`${r.stdout}${r.stderr}`.trim() || "Pulled.") : `ERROR: ${r.stderr.trim() || "git pull failed"}`;
  },
};

export const gitPushTool: ToolDefinition = {
  name: "git_push",
  description: "Push the current branch. Set set_upstream=true to set the upstream on first push.",
  tier: "execute",
  parameters: { type: "object", properties: { set_upstream: { type: "boolean" } } },
  summarize: () => "git push",
  async execute(args, ctx): Promise<string> {
    const r = await git.push(ctx.cwd, { setUpstream: args.set_upstream === true });
    return r.ok ? truncate(`${r.stdout}${r.stderr}`.trim() || "Pushed.") : `ERROR: ${r.stderr.trim() || "git push failed"}`;
  },
};

/**
 * The git tools the model actually sees.
 *
 * Only the read-tier four. They earn their schema budget: they are safe to fan
 * out in parallel, and the host renders their output as structured UI.
 *
 * The seven mutating ones (`add`, `commit`, `branch`, `stash`, `fetch`, `pull`,
 * `push`) are deliberately NOT here. Each was one tool call, so staging,
 * committing and pushing cost three round trips — three full re-sends of the
 * transcript — for what is one `git add -A && git commit -m … && git push` in
 * bash. They also competed with the system prompt's own "use bash for git"
 * instruction. They remain exported for direct host use and for tests; the
 * model reaches them through `bash`, which the bash tool description now says.
 */
export const GIT_TOOLS: ToolDefinition[] = [gitStatusTool, gitLogTool, gitDiffTool, gitBlameTool];

/** The mutating git tools, kept exported for hosts that want to register them. */
export const GIT_WRITE_TOOLS: ToolDefinition[] = [
  gitAddTool,
  gitCommitTool,
  gitBranchTool,
  gitStashTool,
  gitFetchTool,
  gitPullTool,
  gitPushTool,
];
