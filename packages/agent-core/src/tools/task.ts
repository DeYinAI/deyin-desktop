import type { SubagentDefinition } from "../capabilities/subagents.js";
import type { ToolDefinition } from "../types.js";
import { asString } from "./util.js";

export interface TaskRunResult {
  ok: boolean;
  report: string;
}

export interface TaskToolOptions {
  subagents: SubagentDefinition[];
  /**
   * Host callback that actually runs the subagent with a clean context
   * (fresh transcript: subagent system prompt + this prompt only).
   */
  runSubagent: (def: SubagentDefinition, prompt: string, signal?: AbortSignal) => Promise<TaskRunResult>;
  /** Called when a background subagent starts; return a job id for the wait tool. */
  onBackgroundStart?: (def: SubagentDefinition, prompt: string) => string;
  /** Background completion sink (UI notification). */
  onBackgroundDone?: (jobId: string, def: SubagentDefinition, result: TaskRunResult) => void;
}

/** Shared with context-usage so the subagent catalog can be split from the task schema. */
export const TASK_SUBAGENT_CATALOG_MARKER = "Available subagents:\n";

/**
 * The Task tool: lets the model delegate work to a named subagent. Subagents
 * get a clean context window, so the description tells the model to embed all
 * necessary context in the prompt. Background subagents return immediately.
 *
 * Continuity: foreground calls block until the subagent finishes; only
 * {@link TaskRunResult.report} is injected as the tool result — the parent's
 * chat thread never forks.
 */
export function createTaskTool(opts: TaskToolOptions): ToolDefinition {
  const catalog = opts.subagents
    .map((s) => `- ${s.name}: ${s.description}${s.isBackground ? " (background)" : ""}`)
    .join("\n");

  return {
    name: "task",
    description:
      "Delegate a self-contained task to a specialized subagent and get its report back. The subagent starts with a CLEAN context: write the prompt as a task contract with (1) Context — the larger goal and any constraints; (2) Request — one clear action; (3) Output format — the exact shape of the report; (4) Boundaries — what NOT to do, and to mark missing info as uncertain; (5) Pause policy — only stop early for irreversible/external effects, scope changes, or information only the user can provide. " +
      TASK_SUBAGENT_CATALOG_MARKER +
      catalog,
    tier: "execute",
    parameters: {
      type: "object",
      properties: {
        subagent: { type: "string", description: "Name of the subagent to run." },
        prompt: { type: "string", description: "Complete task description with all necessary context." },
        background: {
          type: "boolean",
          description: "Run in the background and return immediately (default follows the subagent definition).",
        },
      },
      required: ["subagent", "prompt"],
    },
    summarize: (args) => `${String(args.subagent ?? "?")}: ${String(args.prompt ?? "").slice(0, 100)}`,
    async execute(args, ctx): Promise<string> {
      const name = asString(args.subagent, "subagent").toLowerCase();
      const prompt = asString(args.prompt, "prompt");
      const def = opts.subagents.find((s) => s.name === name);
      if (!def) {
        const names = opts.subagents.map((s) => s.name).join(", ");
        return `ERROR: unknown subagent "${name}". Available: ${names}.`;
      }
      const background = typeof args.background === "boolean" ? args.background : def.isBackground;
      if (background) {
        const jobId = opts.onBackgroundStart?.(def, prompt) ?? "";
        void opts
          .runSubagent(def, prompt, ctx.signal)
          .then((result) => opts.onBackgroundDone?.(jobId, def, result))
          .catch((err) =>
            opts.onBackgroundDone?.(jobId, def, {
              ok: false,
              report: err instanceof Error ? err.message : String(err),
            }),
          );
        const idHint = jobId ? ` (job_id: ${jobId})` : "";
        return (
          `Background subagent "${def.name}" started${idHint}. ` +
          "Use wait with job_ids to collect results, or continue with other work."
        );
      }
      const result = await opts.runSubagent(def, prompt, ctx.signal);
      return result.ok ? result.report : `Subagent "${def.name}" failed: ${result.report}`;
    },
  };
}

