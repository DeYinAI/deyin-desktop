import type { ToolDefinition, ToolSchema } from "@deyin/agent-core";
import type { AgentTool } from "@deyin/superagent";

/**
 * The built-in tools a worker may use: reading, searching and editing files inside its ticket directory, and the shell. Nothing that
 * needs a person (questions, plans, mode switches), nothing that drives the desktop or a browser, and nothing that reaches into the
 * user's own memory, worktrees or other agents. The ticket's domain tools come in on top of these.
 */
export const WORKER_BUILTIN_TOOLS: readonly string[] = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "delete",
  "grep",
  "glob",
  "ls",
  "file_tree",
  "repo_map",
  "diff_text",
  "git_status",
  "git_log",
  "git_diff",
  "git_blame",
  "bash",
  "await",
  "wait",
  "web_fetch",
  "websearch",
  "todo_write",
  "todo_read",
];

/** Tools that run an arbitrary command line, so the blocked-command screen applies to them. */
export const COMMAND_TOOLS: readonly string[] = ["bash"];

function parametersOf(tool: AgentTool): ToolSchema {
  const { type, properties, required, ...rest } = tool.parameters as { type?: unknown; properties?: unknown; required?: unknown };
  if (type !== "object") throw new Error(`Tool ${tool.name}: parameters must be a JSON Schema object`);
  return {
    ...rest,
    type: "object",
    properties: properties && typeof properties === "object" ? (properties as Record<string, unknown>) : {},
    ...(Array.isArray(required) ? { required: required.filter((name): name is string => typeof name === "string") } : {}),
  };
}

/**
 * Presents a Superagent tool to the agent loop. These tools act on Superagent's own state, never on the user's machine, so they are
 * read-tier (no prompt); a thrown error reaches the model as an `ERROR:` result.
 */
export function toToolDefinition(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: parametersOf(tool),
    tier: "read",
    summarize: () => tool.name,
    neverElide: true,
    async execute(args, ctx) {
      const result = await tool.execute(args, ctx.signal ?? new AbortController().signal);
      if (typeof result === "string") return result;
      return result === undefined ? "ok" : JSON.stringify(result);
    },
  };
}
