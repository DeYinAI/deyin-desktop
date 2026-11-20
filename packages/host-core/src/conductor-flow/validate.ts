import { CONDUCTOR_ROLES, conductorRolePreferenceConflict, isConductorRole, type ConductorRolePreferences } from "../conductor-roles.js";
import type { ConductorWorkflowDefinition } from "../types.js";

/** What the validator needs to know about a detected external agent. */
export interface ConductorAgentFacts {
  id: string;
  installed: boolean;
  availableModels: readonly string[];
}

export interface ConductorWorkflowValidationOptions {
  /**
   * The user's explicit role -> agent choices. With these and the detected
   * agents, a stage that runs a different agent than the one chosen for its
   * role draws a warning (never an error: the role is advisory).
   */
  rolePreferences?: ConductorRolePreferences;
}

export interface ConductorWorkflowValidation {
  /** True when there are no errors; warnings never fail validation. */
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** The checked definition, present only when `ok`. */
  workflow?: ConductorWorkflowDefinition;
}

/** Ids end up in file names and `{{stage.<id>.output}}` tokens, so keep them to one safe shape. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const STALL_ACTIONS: readonly string[] = ["alert-user", "auto-nudge", "retry-stage", "fail-stage"];
/** Properties the interpolator can resolve on an upstream stage. */
const STAGE_PROPERTIES: readonly string[] = ["output", "diff", "branch", "error"];
/** Same expression the interpolator uses, so both agree on what counts as a token. */
const TOKEN_PATTERN = /\{\{\s*([^}]+)\s*\}\}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Check a pipeline definition before it is written or run: shape, unique stage
 * ids, `{{stage.<id>.*}}` references that can actually resolve, and (when the
 * detected agents are supplied) that every stage names a real agent.
 */
export function validateConductorWorkflow(
  raw: unknown,
  agents?: readonly ConductorAgentFacts[],
  options: ConductorWorkflowValidationOptions = {},
): ConductorWorkflowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ["The pipeline must be a JSON object."], warnings };
  }

  const id = text(raw.id);
  if (!id) errors.push('Missing "id".');
  else if (!ID_PATTERN.test(id)) {
    errors.push(`"id" must be kebab-case (lowercase letters, digits, hyphens), got "${id}".`);
  }
  if (!text(raw.name)) errors.push('Missing "name".');
  if (typeof raw.createdAt !== "number" || typeof raw.updatedAt !== "number") {
    errors.push('"createdAt" and "updatedAt" must be numbers: the current time in milliseconds.');
  }

  const agentById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
  const stages = Array.isArray(raw.stages) ? raw.stages : null;
  if (!stages || stages.length === 0) {
    errors.push('"stages" must be a non-empty array.');
  } else {
    const stageIds = stages.map((stage) => (isRecord(stage) ? text(stage.id) : ""));
    let usesInputs = false;

    stages.forEach((stage, index) => {
      const label = `Stage ${index + 1}${stageIds[index] ? ` "${stageIds[index]}"` : ""}`;
      if (!isRecord(stage)) {
        errors.push(`${label} must be an object.`);
        return;
      }

      const stageId = stageIds[index]!;
      if (!stageId) errors.push(`${label} is missing "id".`);
      else if (!ID_PATTERN.test(stageId)) {
        errors.push(`${label}: "id" must be kebab-case (no dots or spaces) so {{stage.${stageId}.output}} resolves.`);
      } else if (stageIds.indexOf(stageId) !== index) {
        errors.push(`${label}: duplicate stage id.`);
      }
      if (!text(stage.name)) errors.push(`${label} is missing "name".`);

      const roleText = text(stage.role);
      if (stage.role !== undefined && !isConductorRole(roleText)) {
        errors.push(`${label}: "role" must be one of ${CONDUCTOR_ROLES.join(", ")}, got ${JSON.stringify(stage.role)}.`);
      }

      const agentId = text(stage.agentId);
      if (!agentId) errors.push(`${label} is missing "agentId".`);
      else if (agentById.size > 0) {
        const agent = agentById.get(agentId);
        if (!agent) {
          errors.push(`${label}: unknown agent "${agentId}". Detected agents: ${[...agentById.keys()].join(", ")}.`);
        } else {
          if (!agent.installed) warnings.push(`${label}: agent "${agentId}" is not installed, so this stage will fail until it is.`);
          const preferred = conductorRolePreferenceConflict(
            isConductorRole(roleText) ? roleText : undefined,
            agentId,
            options.rolePreferences ?? {},
            agents ?? [],
          );
          if (preferred) {
            warnings.push(`${label}: you prefer "${preferred}" for ${roleText} stages, but this stage runs "${agentId}".`);
          }
          const model = text(stage.modelOverride);
          if (model && agent.availableModels.length > 0 && !agent.availableModels.includes(model)) {
            warnings.push(`${label}: model "${model}" is not in ${agentId}'s detected models (${agent.availableModels.join(", ")}).`);
          }
        }
      }

      if (!text(stage.userPromptTemplate)) errors.push(`${label} is missing "userPromptTemplate".`);

      for (const field of ["userPromptTemplate", "systemPrompt"] as const) {
        const template = typeof stage[field] === "string" ? stage[field] : "";
        for (const match of template.matchAll(TOKEN_PATTERN)) {
          const token = match[1]!.trim();
          if (token === "artifacts" || token === "workspace.root") continue;
          if (token.startsWith("inputs.")) {
            usesInputs = true;
            continue;
          }
          if (token.startsWith("stage.")) {
            const [, ref, prop] = token.split(".");
            if (!ref || !prop) {
              warnings.push(`${label}: {{${token}}} is incomplete; use {{stage.<id>.output}}.`);
              continue;
            }
            const refIndex = stageIds.indexOf(ref);
            if (refIndex === -1) errors.push(`${label}: {{${token}}} refers to a stage that does not exist.`);
            else if (refIndex >= index) {
              errors.push(`${label}: {{${token}}} refers to a stage that has not run yet. Only earlier stages can be used.`);
            } else if (!STAGE_PROPERTIES.includes(prop)) {
              warnings.push(`${label}: {{${token}}} has no "${prop}" property; use ${STAGE_PROPERTIES.join(", ")}.`);
            }
            continue;
          }
          warnings.push(`${label}: {{${token}}} is not a known variable and resolves to empty text.`);
        }
      }

      if (stage.watchdog !== undefined) {
        const watchdog = stage.watchdog;
        if (!isRecord(watchdog)) {
          errors.push(`${label}: "watchdog" must be an object.`);
        } else {
          if (!isPositive(watchdog.timeoutMs)) errors.push(`${label}: watchdog.timeoutMs must be a positive number of milliseconds.`);
          if (!isPositive(watchdog.stallThresholdMs)) {
            errors.push(`${label}: watchdog.stallThresholdMs must be a positive number of milliseconds.`);
          }
          if (typeof watchdog.onStallAction !== "string" || !STALL_ACTIONS.includes(watchdog.onStallAction)) {
            errors.push(`${label}: watchdog.onStallAction must be one of ${STALL_ACTIONS.join(", ")}.`);
          }
          if (isPositive(watchdog.timeoutMs) && isPositive(watchdog.stallThresholdMs) && watchdog.stallThresholdMs >= watchdog.timeoutMs) {
            warnings.push(`${label}: the stall threshold is not shorter than the timeout, so a stall is never flagged before the stage times out.`);
          }
        }
      }
    });

    if (usesInputs) {
      warnings.push(
        "{{inputs.*}} is empty when the pipeline is started from the Run button or the scheduler. Write the goal into the first stage's prompt, or start the run with a goal from chat.",
      );
    }
  }

  if (raw.schedule !== undefined) {
    const schedule = raw.schedule;
    if (!isRecord(schedule) || typeof schedule.enabled !== "boolean") {
      errors.push('"schedule" must be an object with a boolean "enabled".');
    } else if (schedule.enabled && !text(schedule.cronExpression) && !isPositive(schedule.intervalMinutes)) {
      errors.push('"schedule" is enabled but has neither a "cronExpression" nor a positive "intervalMinutes".');
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, errors, warnings, workflow: raw as unknown as ConductorWorkflowDefinition };
}
