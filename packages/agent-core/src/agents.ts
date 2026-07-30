import type { PermissionRule } from "./permissions.js";

export interface AgentDefinition {
  name: string;
  description: string;
  /** Agent-specific paragraph appended to the base system prompt. */
  prompt: string;
  /** Agent-level permission overrides (merged under user config rules). */
  permissions?: PermissionRule[];
  /** Preferred model; falls back to the run's model when absent. */
  model?: string;
  maxSteps?: number;
}

export const BUILD_AGENT: AgentDefinition = {
  name: "build",
  description: "Full-access default agent for development work.",
  prompt:
    "You are in build mode: implement the user's request end to end. Make the code changes yourself with the write/edit tools, run relevant checks with bash, and keep going until the task is complete or you are truly blocked. Batch independent reads/searches/checks in one turn; combine related shell commands with && when order matters. Avoid one-tool-per-turn probing and big speculative rewrites.",
};

export const PLAN_AGENT: AgentDefinition = {
  name: "plan",
  description: "Read-only agent for analysis and planning; never edits files.",
  prompt:
    "You are in plan mode: explore and analyze, then propose a concrete plan. You must NOT modify the workspace. Use read/grep/glob/ls to gather evidence. Order matters: (1) research with tools, (2) call todo_write once with one pending todo per numbered implementation step (stable ids, short imperative content), (3) only after todo_write, output the full plan as your final markdown message with no further tool calls. Write that final message as markdown: a short title (# heading), a summary paragraph, then numbered steps citing the concrete files to change. The todo list is how Build tracks progress — do not skip it, and do not put the plan markdown before todo_write.",
  permissions: [
    { tool: "write", action: "deny" },
    { tool: "edit", action: "deny" },
    { tool: "bash", action: "ask" },
  ],
};

export const ASK_AGENT: AgentDefinition = {
  name: "ask",
  description: "Read-only Q&A agent: explores and explains, never changes anything.",
  prompt:
    "You are in ask mode: answer the user's questions about the codebase and anything else they need. Explore with read/grep/glob/ls and cite concrete files and lines in your answers. You must NOT modify the workspace or run commands; if the user asks for a change, describe it and suggest switching to agent mode to apply it.",
  permissions: [
    { tool: "write", action: "deny" },
    { tool: "edit", action: "deny" },
    { tool: "bash", action: "deny" },
  ],
};

export const BUILTIN_AGENTS: AgentDefinition[] = [BUILD_AGENT, PLAN_AGENT, ASK_AGENT];
