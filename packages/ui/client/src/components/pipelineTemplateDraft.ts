import {
  instantiateConductorTemplate,
  resolveConductorRoleAgent,
  type ConductorPipelineTemplate,
  type ConductorRolePreferences,
} from "@deyin/host-core/shared";
import type { ConductorWorkflowDefinition, ExternalAgentDescriptor } from "@deyin/contract";

/**
 * Stands in for the user's goal in a pipeline started from a template. The
 * Execute button passes no inputs, so `{{inputs.goal}}` would reach the agent
 * as nothing; visible text in the prompt is something the user can see and edit.
 */
export const TEMPLATE_GOAL_PLACEHOLDER = "[Describe the goal here]";

/** Used for a stage when no agent is installed at all, so the draft is still well-formed. */
const NO_AGENT_FALLBACK = "codex";

/**
 * An editable, unsaved pipeline from a template: each stage's agent is the one
 * the user prefers for that stage's role, else the usual choice, else the first
 * installed agent.
 */
export function draftFromTemplate(
  template: ConductorPipelineTemplate,
  agents: readonly ExternalAgentDescriptor[],
  preferences: ConductorRolePreferences,
): ConductorWorkflowDefinition {
  const fallback = agents.find((agent) => agent.installed)?.id ?? NO_AGENT_FALLBACK;
  return instantiateConductorTemplate(template, {
    agentForRole: (role) => resolveConductorRoleAgent(role, preferences, agents)?.agentId ?? fallback,
    goal: TEMPLATE_GOAL_PLACEHOLDER,
    id: "",
  });
}
