import type { SubagentDefinition } from "../capabilities/subagents.js";
import type { ToolDefinition } from "../types.js";
import type { TaskRunResult } from "./task.js";
import { asString } from "./util.js";

export interface ParallelTasksToolOptions {
  subagents: SubagentDefinition[];
  /** Default read-only subagent; falls back to first readonly subagent or explorer. */
  defaultSubagent?: string;
  runSubagent: (def: SubagentDefinition, prompt: string, signal?: AbortSignal) => Promise<TaskRunResult>;
  acquireSlot?: (signal?: AbortSignal) => Promise<() => void>;
}

const PARALLEL_MIN = 2;
const PARALLEL_MAX = 64;

function pickResearchAgent(subagents: SubagentDefinition[], name?: string): SubagentDefinition | undefined {
  if (name) {
    const found = subagents.find((s) => s.name === name.toLowerCase());
    if (found) return found;
  }
  return subagents.find((s) => s.readonly) ?? subagents[0];
}

/**
 * Read-only parallel research tasks (simplified fleet variant).
 */
export function createParallelTasksTool(opts: ParallelTasksToolOptions): ToolDefinition {
  return {
    name: "parallel_tasks",
    description: "Execute 2–64 read-only research tasks in parallel and aggregate findings.",
    tier: "read",
    parameters: {
      type: "object",
      properties: {
        prompts: {
          type: "array",
          items: { type: "string" },
          minItems: PARALLEL_MIN,
          maxItems: PARALLEL_MAX,
          description: "Research prompts to execute in parallel.",
        },
        subagent: {
          type: "string",
          description: "Optional read-only subagent profile (default: explorer).",
        },
      },
      required: ["prompts"],
    },
    summarize: (args) => {
      const prompts = (args.prompts as string[] | undefined) ?? [];
      return `parallel_tasks (${prompts.length} research tasks)`;
    },
    async execute(args, ctx): Promise<string> {
      const prompts = (args.prompts as string[] | undefined) ?? [];
      if (prompts.length < PARALLEL_MIN || prompts.length > PARALLEL_MAX) {
        return `ERROR: parallel_tasks requires between ${PARALLEL_MIN} and ${PARALLEL_MAX} prompts.`;
      }

      const subagentName = typeof args.subagent === "string" ? args.subagent : opts.defaultSubagent;
      const def = pickResearchAgent(opts.subagents, subagentName);
      if (!def) {
        return "ERROR: no subagent available for parallel_tasks.";
      }

      const outputs: string[] = new Array(prompts.length).fill("");
      const errors: (string | undefined)[] = new Array(prompts.length);

      await Promise.all(
        prompts.map(async (raw, index) => {
          const prompt = asString(raw, `prompts[${index}]`);
          let release: (() => void) | undefined;
          try {
            if (opts.acquireSlot) {
              release = await opts.acquireSlot(ctx.signal);
            }
            const result = await opts.runSubagent(def, prompt, ctx.signal);
            if (result.ok) {
              outputs[index] = result.report;
            } else {
              errors[index] = result.report;
            }
          } catch (err) {
            errors[index] = err instanceof Error ? err.message : String(err);
          } finally {
            release?.();
          }
        }),
      );

      let out = `Completed ${prompts.length} parallel research tasks:\n`;
      for (let i = 0; i < prompts.length; i++) {
        out += `── task-${i + 1} ──\n`;
        if (errors[i]) {
          out += `[FAILED] ${errors[i]}\n`;
        } else {
          out += `${outputs[i]?.trim() ?? "(no output)"}\n`;
        }
      }
      return out;
    },
  };
}
