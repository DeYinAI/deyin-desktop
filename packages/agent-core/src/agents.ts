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
    "You are in build mode: implement the user's request end to end. Make the code changes yourself with the write/edit tools, run relevant checks with bash, and keep going until the task is complete or you are truly blocked. Prefer small verifiable steps over big speculative rewrites.",
};

export const PLAN_AGENT: AgentDefinition = {
  name: "plan",
  description: "Read-only agent for analysis and planning; never edits files.",
  prompt:
    "You are in plan mode: explore and analyze, then propose a concrete plan. You must NOT modify the workspace. Use read/grep/glob/ls to gather evidence and finish with a step-by-step plan the user can approve.",
  permissions: [
    { tool: "write", action: "deny" },
    { tool: "edit", action: "deny" },
    { tool: "bash", action: "ask" },
  ],
};

export const BUILTIN_AGENTS: AgentDefinition[] = [BUILD_AGENT, PLAN_AGENT];
