import type { SubagentDefinition } from "../capabilities/subagents.js";
import type { ToolDefinition } from "../types.js";
import type { AcquireRequest } from "../scheduler/subagent-scheduler.js";
import {
  normalizeWritePaths,
  wholeWorkspaceWriteClaim,
  writePathSetEmpty,
  type WritePathSet,
} from "../scheduler/write-claims.js";
import { asOptionalBoolean, asString, asStringArray } from "./util.js";

export interface TaskRunResult {
  ok: boolean;
  report: string;
}

export interface TaskToolOptions {
  subagents: SubagentDefinition[];
  cwd: string;
  /**
   * Host callback that actually runs the subagent with a clean context
   * (fresh transcript: subagent system prompt + this prompt only).
   */
  runSubagent: (
    def: SubagentDefinition,
    prompt: string,
    opts?: { writePaths?: WritePathSet; signal?: AbortSignal; nested?: boolean },
  ) => Promise<TaskRunResult>;
  acquireSlot?: (req: AcquireRequest, signal?: AbortSignal) => Promise<() => void>;
  /** Background completion sink (UI notification). */
  onBackgroundDone?: (def: SubagentDefinition, result: TaskRunResult, jobId: string) => void;
}

/** Shared with context-usage so the subagent catalog can be split from the task schema. */
export const TASK_SUBAGENT_CATALOG_MARKER = "Available subagents:\n";

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
      "Delegate a self-contained task to a specialized subagent and get its report back. The subagent starts with a CLEAN context: include every needed detail (paths, requirements, expected output) in the prompt. " +
      "Writers may declare write_paths for parallel coordination; omitting write_paths on a writer claims the whole workspace. " +
      TASK_SUBAGENT_CATALOG_MARKER +
      catalog,
    tier: "execute",
    parameters: {
      type: "object",
      properties: {
        subagent: { type: "string", description: "Name of the subagent to run." },
        prompt: { type: "string", description: "Complete task description with all necessary context." },
        write_paths: {
          type: "array",
          items: { type: "string" },
          description: "Files this subagent will modify (for write-path coordination).",
        },
        is_background: {
          type: "boolean",
          description: "Run in the background and return immediately with a job ID (collect with wait).",
        },
        background: {
          type: "boolean",
          description: "Alias for is_background (deprecated).",
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

      const isBackground =
        asOptionalBoolean(args.is_background) ??
        asOptionalBoolean(args.background) ??
        def.isBackground;

      let writePaths: WritePathSet = { paths: [], wholeWorkspace: false, workspaceRoot: opts.cwd };
      const isWriter = !def.readonly;
      if (isWriter && Array.isArray(args.write_paths) && args.write_paths.length > 0) {
        writePaths = normalizeWritePaths(opts.cwd, asStringArray(args.write_paths, "write_paths"));
      } else if (isWriter && isBackground) {
        writePaths = wholeWorkspaceWriteClaim(opts.cwd);
      }

      const runOnce = async (signal?: AbortSignal): Promise<TaskRunResult> => {
        let release: (() => void) | undefined;
        try {
          if (opts.acquireSlot) {
            release = await opts.acquireSlot(
              {
                writer: isWriter,
                writePaths,
                nested: false,
                label: def.name,
              },
              signal,
            );
          }
          return await opts.runSubagent(def, prompt, {
            writePaths: writePathSetEmpty(writePaths) ? undefined : writePaths,
            signal,
            nested: false,
          });
        } finally {
          release?.();
        }
      };

      if (isBackground) {
        if (!ctx.registerBackgroundJob) {
          void runOnce(ctx.signal)
            .then((result) => opts.onBackgroundDone?.(def, result, ""))
            .catch((err) =>
              opts.onBackgroundDone?.(def, {
                ok: false,
                report: err instanceof Error ? err.message : String(err),
              }, ""),
            );
          return `Background subagent "${def.name}" started. Its report will surface when it completes.`;
        }

        const jobId = ctx.registerBackgroundJob({
          kind: "task",
          label: def.name,
          profile: def.name,
          prompt,
          run: async (signal) => {
            const result = await runOnce(signal);
            if (!result.ok) throw new Error(result.report);
            return result.report;
          },
        });
        return `Started background job "${jobId}" for subagent "${def.name}". Collect results with the wait tool.`;
      }

      const result = await runOnce(ctx.signal);
      return result.ok ? result.report : `Subagent "${def.name}" failed: ${result.report}`;
    },
  };
}
