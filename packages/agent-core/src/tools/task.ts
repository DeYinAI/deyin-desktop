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
  /** Background completion sink (UI notification). */
  onBackgroundDone?: (def: SubagentDefinition, result: TaskRunResult) => void;
}

/**
 * The Task tool: lets the model delegate work to a named subagent. Subagents
 * get a clean context window, so the description tells the model to embed all
 * necessary context in the prompt. Background subagents return immediately.
 */
export function createTaskTool(opts: TaskToolOptions): ToolDefinition {
  const catalog = opts.subagents
    .map((s) => `- ${s.name}: ${s.description}${s.isBackground ? " (background)" : ""}`)
    .join("\n");

  return {
    name: "task",
    description:
      "Delegate a self-contained task to a specialized subagent and get its report back. The subagent starts with a CLEAN context: include every needed detail (paths, requirements, expected output) in the prompt. Available subagents:\n" +
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
        void opts
          .runSubagent(def, prompt, ctx.signal)
          .then((result) => opts.onBackgroundDone?.(def, result))
          .catch((err) =>
            opts.onBackgroundDone?.(def, { ok: false, report: err instanceof Error ? err.message : String(err) }),
          );
        return `Background subagent "${def.name}" started. Its report will surface in the session when it completes; continue with other work.`;
      }
      const result = await opts.runSubagent(def, prompt, ctx.signal);
      return result.ok ? result.report : `Subagent "${def.name}" failed: ${result.report}`;
    },
  };
}

