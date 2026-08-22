import type { Automation, AutomationPayload } from "@deyin/host-core";
import type { SkillDefinition, SubagentDefinition } from "@deyin/agent-core";

/**
 * An automation's payload resolved against the live capability registry.
 *
 * Skills and subagents are looked up by name at run time rather than being
 * copied into the automation, so editing a SKILL.md changes what every
 * automation naming it does — the same contract a `/name` chat invocation has.
 */
export interface ResolvedPayload {
  /** The user turn to send. */
  prompt: string;
  /**
   * Set when the payload names a subagent AND the target can delegate directly
   * (local runs). Out-of-process targets get a delegation *prompt* instead,
   * because the CLI registers its own subagent tool.
   */
  subagent?: SubagentDefinition;
}

export class PayloadResolutionError extends Error {}

/** Skill invocation text. Mirrors the `/name` expansion in DesktopAgentHost. */
export function skillPrompt(skill: SkillDefinition, input?: string): string {
  return `Read the skill file at ${skill.path} with the read tool and follow it for this task: ${
    input?.trim() || "(no extra arguments)"
  }`;
}

/** Delegation text for targets that cannot call runSubagent in-process. */
export function subagentPrompt(def: SubagentDefinition, input?: string): string {
  return `Delegate this task to the "${def.name}" subagent using the task tool: ${
    input?.trim() || "(no extra arguments)"
  }`;
}

export interface ResolveOptions {
  skills: SkillDefinition[];
  subagents: SubagentDefinition[];
  /** Local runs delegate in-process; wsl/ssh runs go through the CLI. */
  canDelegateInProcess: boolean;
}

/**
 * Resolve a payload to the text the run should start from. Throws when a named
 * capability is missing or disabled, so the run fails loudly with an actionable
 * message rather than silently sending "undefined" to the model.
 */
export function resolvePayload(payload: AutomationPayload, opts: ResolveOptions): ResolvedPayload {
  switch (payload.kind) {
    case "prompt":
      return { prompt: payload.prompt };

    case "skill": {
      const skill = opts.skills.find((s) => s.name === payload.skill);
      if (!skill) {
        throw new PayloadResolutionError(
          `Skill "${payload.skill}" is not available (missing, or disabled in Settings → Skills).`,
        );
      }
      return { prompt: skillPrompt(skill, payload.input) };
    }

    case "subagent": {
      const def = opts.subagents.find((s) => s.name === payload.subagent);
      if (!def) {
        throw new PayloadResolutionError(
          `Subagent "${payload.subagent}" is not available (missing, or disabled in Settings → Skills).`,
        );
      }
      return opts.canDelegateInProcess
        ? { prompt: payload.input?.trim() || def.description, subagent: def }
        : { prompt: subagentPrompt(def, payload.input) };
    }
  }
}

/** Short human label for run history and notifications. */
export function payloadLabel(automation: Automation): string {
  const p = automation.payload;
  if (p.kind === "skill") return `skill: ${p.skill}`;
  if (p.kind === "subagent") return `subagent: ${p.subagent}`;
  return p.prompt.slice(0, 80);
}
