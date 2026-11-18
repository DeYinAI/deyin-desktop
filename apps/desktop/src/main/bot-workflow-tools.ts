/**
 * Bot pipeline tools for the agent: check a pipeline definition before it is
 * written or run, and start one. Used by the `build-bot-workflow` skill, which
 * interviews the user, drafts a pipeline, validates it here, writes it to
 * `.deyin/workflows/<id>.json`, and offers to run it.
 *
 * Runs go through the same starter as the Bot Flow tab's Run button, so the
 * run strip and monitor in the renderer pick them up like any other run.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition } from "@deyin/agent-core";
import {
  validateBotWorkflow,
  type BotAgentFacts,
  type BotWorkflowDefinition,
  type BotWorkflowValidation,
  type ExternalAgentDescriptor,
} from "@deyin/host-core";

export interface BotWorkflowToolDeps {
  getWorkspaceRoot: () => string | null;
  listWorkflows: () => BotWorkflowDefinition[];
  listAgents: (forceRefresh?: boolean) => Promise<ExternalAgentDescriptor[]>;
  /** Starts a run and returns at once; throws when the pipeline does not exist. */
  startRun: (workflowId: string, cwd: string, inputs?: Record<string, string>) => { runId: string };
}

function optionalString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Detected agents in the validator's terms, or undefined when detection is unavailable. */
async function detectAgents(deps: BotWorkflowToolDeps): Promise<BotAgentFacts[] | undefined> {
  try {
    const agents = await deps.listAgents(false);
    return agents.map((a) => ({ id: a.id, installed: a.installed, availableModels: a.availableModels }));
  } catch {
    return undefined;
  }
}

function stageChain(workflow: BotWorkflowDefinition): string {
  return workflow.stages.map((stage) => `${stage.id} (${stage.agentId})`).join(" → ");
}

function bullets(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

function report(validation: BotWorkflowValidation, extra: string[] = []): string {
  if (!validation.ok) {
    const count = validation.errors.length;
    return [
      `INVALID: ${count} ${count === 1 ? "error" : "errors"}.`,
      bullets(validation.errors),
      ...(validation.warnings.length > 0 ? ["Warnings:", bullets(validation.warnings)] : []),
      "Fix these and call bot_workflow_validate again.",
    ].join("\n");
  }
  const workflow = validation.workflow!;
  return [
    `OK: "${workflow.name}" (${workflow.id}) has ${workflow.stages.length} ${workflow.stages.length === 1 ? "stage" : "stages"}: ${stageChain(workflow)}.`,
    ...extra,
    ...(validation.warnings.length > 0 ? ["Warnings:", bullets(validation.warnings)] : []),
  ].join("\n");
}

function createValidateTool(deps: BotWorkflowToolDeps): ToolDefinition {
  return {
    name: "bot_workflow_validate",
    description:
      "Check a bot pipeline definition: required fields, unique kebab-case stage ids, {{stage.<id>.output}} references that point at earlier stages, and agent ids against the detected external agents. Pass `workflow` to check a draft before writing it, or `path` to check a file already written (this also confirms Bot Mode has registered it). Returns OK or a list of errors to fix.",
    tier: "read",
    parameters: {
      type: "object",
      properties: {
        workflow: {
          type: "object",
          description: "The pipeline definition (id, name, stages, createdAt, updatedAt, ...) to check.",
        },
        path: {
          type: "string",
          description: "Workspace-relative path of a pipeline JSON file, e.g. .deyin/workflows/ship-feature.json.",
        },
      },
    },
    summarize: (args) => {
      const path = optionalString(args, "path");
      return path ? `validate ${path}` : "validate pipeline draft";
    },
    async execute(args): Promise<string> {
      const path = optionalString(args, "path");
      const agents = await detectAgents(deps);
      const notes = agents ? [] : ["Warning: external agents could not be detected, so agent ids were not checked."];

      if (args.workflow !== undefined) {
        const result = validateBotWorkflow(args.workflow, agents);
        return [report(result), ...notes].join("\n");
      }
      if (!path) return "ERROR: pass either `workflow` (a draft) or `path` (a file in the workspace).";

      const root = deps.getWorkspaceRoot();
      if (!root) return "ERROR: no workspace is open, so there is no .deyin/workflows folder to check.";
      const file = resolve(root, path);
      const rel = relative(root, file);
      if (rel.startsWith("..") || isAbsolute(rel)) return `ERROR: ${path} is outside the workspace.`;

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
      } catch (err) {
        return `INVALID: ${path} could not be read as JSON (${err instanceof Error ? err.message : String(err)}).`;
      }

      const result = validateBotWorkflow(parsed, agents);
      const id = result.workflow?.id;
      const registered = id !== undefined && deps.listWorkflows().some((w) => w.id === id);
      const registration = !result.ok
        ? []
        : registered
          ? ["Registered: it appears in Bot Mode > Bot Flow."]
          : ["NOT registered: Bot Mode only reads .deyin/workflows/*.json in the open workspace. Move or rewrite the file there."];
      return [report(result, registration), ...notes].join("\n");
    },
  };
}

function createRunTool(deps: BotWorkflowToolDeps): ToolDefinition {
  return {
    name: "bot_workflow_run",
    description:
      "Start a saved bot pipeline and return immediately. Progress shows in the run strip above the composer and in the Bot Flow tab; do not poll for it. `goal` is only used by pipelines whose prompts contain {{inputs.goal}}.",
    tier: "execute",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "The pipeline's id (the `id` field of its JSON)." },
        goal: { type: "string", description: "Optional value for {{inputs.goal}}." },
      },
      required: ["workflow_id"],
    },
    summarize: (args) => `run pipeline ${optionalString(args, "workflow_id") || "?"}`,
    async execute(args): Promise<string> {
      const id = optionalString(args, "workflow_id");
      if (!id) return "ERROR: workflow_id is required.";

      const workflows = deps.listWorkflows();
      const workflow = workflows.find((w) => w.id === id);
      if (!workflow) {
        const known = workflows.map((w) => w.id);
        return `ERROR: no pipeline with id "${id}".${known.length > 0 ? ` Known ids: ${known.join(", ")}.` : " None are saved yet."}`;
      }

      // Re-check at the last moment: the file may have been edited since it was validated.
      const validation = validateBotWorkflow(workflow, await detectAgents(deps));
      if (!validation.ok) return `NOT STARTED.\n${report(validation)}`;

      const goal = optionalString(args, "goal");
      try {
        const { runId } = deps.startRun(id, deps.getWorkspaceRoot() ?? "", goal ? { goal } : undefined);
        return `Started "${workflow.name}" (run ${runId}): ${stageChain(workflow)}. It is running in the background; progress shows above the composer and in the Bot Flow tab.`;
      } catch (err) {
        return `ERROR: could not start the pipeline: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createBotWorkflowTools(deps: BotWorkflowToolDeps): ToolDefinition[] {
  return [createValidateTool(deps), createRunTool(deps)];
}
