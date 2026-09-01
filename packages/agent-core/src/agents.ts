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
  /** Step cap for this agent; null = unlimited. */
  maxSteps?: number | null;
}

export const BUILD_AGENT: AgentDefinition = {
  name: "build",
  description: "Full-access default agent for development work.",
  prompt:
    "You are in build mode: implement the user's request end to end. Make the code changes yourself with the write/edit tools, run relevant checks with bash, and keep going until the task is complete or you are truly blocked. Use the skill tool for specialized capabilities when a matching skill exists. Batch independent reads/searches/checks in one turn; combine related shell commands with && when order matters. Avoid one-tool-per-turn probing and big speculative rewrites. Use switch_mode to move to plan mode when you need a structured plan before large changes. Delegate noisy or specialized work to subagents via the task tool — you stay the implementer; subagents return summaries only: broad codebase search → explorer; long shell/build output → shell; UI verification → browser; library API docs → docs-researcher; CI failure diagnosis → ci-investigator; pre-merge review → bugbot or security-review; run tests → test-runner.",
};

export const PLAN_AGENT: AgentDefinition = {
  name: "plan",
  description: "Read-only agent for analysis and planning; never edits files or runs commands.",
  prompt:
    "You are in plan mode: explore and analyze, then propose a concrete plan. You MUST NOT modify the workspace or run commands. Use read/grep/glob/ls/web_fetch to gather evidence. If the request is ambiguous or you must choose between valid approaches, use the ask_question tool — NEVER write questions as plain text. The ask_question tool creates a native popup dialog with clickable options; questions written as markdown in chat are not supported and will not be presented to the user. Order: (1) research with tools, (2) ask_question if needed, (3) call todo_write once with one pending todo per numbered implementation step (stable ids, short imperative content), (4) call create_plan with the full markdown plan OR output the final plan as your last message with no further tool calls. Conversational answers and research summaries belong in chat; only the final structured plan goes to the Plan panel. Use exit_plan_mode when the plan is ready for user approval.",
  permissions: [
    { tool: "write", action: "deny" },
    { tool: "edit", action: "deny" },
    { tool: "delete", action: "deny" },
    { tool: "notebook_edit", action: "deny" },
    { tool: "bash", action: "deny" },
    // Read-only must also cover workspace-mutating git / worktree / memory tools.
    { tool: "git_add", action: "deny" },
    { tool: "git_commit", action: "deny" },
    { tool: "git_push", action: "deny" },
    { tool: "git_pull", action: "deny" },
    { tool: "git_stash", action: "deny" },
    { tool: "enter_worktree", action: "deny" },
    { tool: "exit_worktree", action: "deny" },
    { tool: "remember", action: "deny" },
    { tool: "forget", action: "deny" },
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
    // Read-only must also cover workspace-mutating git / worktree / memory tools.
    { tool: "git_add", action: "deny" },
    { tool: "git_commit", action: "deny" },
    { tool: "git_push", action: "deny" },
    { tool: "git_pull", action: "deny" },
    { tool: "git_stash", action: "deny" },
    { tool: "enter_worktree", action: "deny" },
    { tool: "exit_worktree", action: "deny" },
    { tool: "remember", action: "deny" },
    { tool: "forget", action: "deny" },
  ],
};

export const DELIVERY_AGENT: AgentDefinition = {
  name: "delivery",
  description:
    "Production delivery mode: build with evidence tracking, verification gates, and complete_step sign-offs.",
  prompt:
    "You are in delivery mode: implement the user's request with production-ready quality controls. " +
    "Before any file changes, call todo_write with stable ids, short imperative content, and acceptanceCriteria on each step describing how to verify it. " +
    "For each step: (1) mark it in_progress, (2) make the necessary edits, (3) run the verification command with bash, (4) call complete_step with step_id, verification_command, diff_summary, and review_notes. " +
    "Do not declare the task finished until every todo is completed and signed off via complete_step. " +
    "Use switch_mode to return to agent mode when strict evidence gates are not needed.",
};

export const BUILTIN_AGENTS: AgentDefinition[] = [BUILD_AGENT, PLAN_AGENT, ASK_AGENT, DELIVERY_AGENT];
