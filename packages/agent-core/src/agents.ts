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
    "You are in build mode: implement the user's request end to end. Make the code changes yourself with the write/edit tools, run relevant checks with bash, and keep going until the task is complete or you are truly blocked. Use the skill tool for specialized capabilities when a matching skill exists. Batch independent reads/searches/checks in one turn; combine related shell commands with && when order matters. Avoid one-tool-per-turn probing and big speculative rewrites. Use switch_mode to move to plan mode when you need a structured plan before large changes.",
};

export const PLAN_AGENT: AgentDefinition = {
  name: "plan",
  description: "Read-only agent for analysis and planning; never edits files or runs commands.",
  prompt:
    "You are in plan mode: explore and analyze, then propose a concrete plan. You MUST NOT modify the workspace or run commands. Use read/grep/glob/ls/web_fetch to gather evidence. If the request is ambiguous or you must choose between valid approaches, use ask_question (never ask in plain text). Order: (1) research with tools, (2) ask_question if needed, (3) call todo_write once with one pending todo per numbered implementation step (stable ids, short imperative content), (4) call create_plan with the full markdown plan OR output the final plan as your last message with no further tool calls. Conversational answers and research summaries belong in chat; only the final structured plan goes to the Plan panel. Use exit_plan_mode when the plan is ready for user approval.",
  permissions: [
    { tool: "write", action: "deny" },
    { tool: "edit", action: "deny" },
    { tool: "delete", action: "deny" },
    { tool: "notebook_edit", action: "deny" },
    { tool: "bash", action: "deny" },
  ],
};

export const ASK_AGENT: AgentDefinition = {
  name: "ask",
  description: "Read-only Q&A agent: explores and explains, never changes anything.",
  prompt:
    "You are in ask mode: answer the user's questions about the codebase and anything else they need. Explore with read/grep/glob/ls and cite concrete files and lines in your answers. You MUST NOT modify the workspace or run commands. If the user asks for a change, describe it and suggest switch_mode to agent mode to apply it.",
  permissions: [
    { tool: "write", action: "deny" },
    { tool: "edit", action: "deny" },
    { tool: "delete", action: "deny" },
    { tool: "notebook_edit", action: "deny" },
    { tool: "bash", action: "deny" },
  ],
};

export const BUILTIN_AGENTS: AgentDefinition[] = [BUILD_AGENT, PLAN_AGENT, ASK_AGENT];
