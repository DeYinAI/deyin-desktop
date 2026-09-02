import type { SubagentDefinition } from "../capabilities/subagents.js";
import type { ToolDefinition } from "../types.js";
import { asString } from "./util.js";

export interface TaskRunResult {
  ok: boolean;
  report: string;
  /**
   * Identifies the child transcript this run produced, so a later call can
   * `resume` or `fork` it. Absent when the host persists no subagent state.
   */
  agentId?: string;
}

/** Per-call overrides the model may attach to one task invocation. */
export interface TaskCallOverrides {
  /**
   * Deny write/edit for this call only. It can tighten a subagent but never
   * loosen one whose definition is already read-only.
   */
  readonly?: boolean;
  /** Model for this call ("providerId::modelId" or a bare id). */
  model?: string;
  /** Continue the transcript of a previous run instead of starting clean. */
  resumeAgentId?: string;
  /** Branch from a previous run, leaving the source transcript untouched. */
  forkAgentId?: string;
  signal?: AbortSignal;
}

export interface TaskToolOptions {
  subagents: SubagentDefinition[];
  /**
   * Host callback that actually runs the subagent with a clean context
   * (fresh transcript: subagent system prompt + this prompt only), or with the
   * resumed/forked transcript when the call asks for one.
   */
  runSubagent: (
    def: SubagentDefinition,
    prompt: string,
    overrides: TaskCallOverrides,
  ) => Promise<TaskRunResult>;
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
        readonly: {
          type: "boolean",
          description:
            "Deny write/edit for this call only. Tightens the subagent; a definition that is already read-only stays read-only.",
        },
        model: {
          type: "string",
          description:
            "Model for this call, as \"providerId::modelId\" or a bare model id. A model the user pinned for this subagent still wins.",
        },
        resume: {
          type: "string",
          description:
            "agent_id from an earlier task result: continues that subagent's own transcript instead of starting clean, so it keeps everything it already learned.",
        },
        fork: {
          type: "string",
          description:
            "agent_id to branch from: the child starts with a copy of that transcript and the original is left untouched. Use to explore two directions from one investigation.",
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
      const resumeAgentId = typeof args.resume === "string" && args.resume ? args.resume : undefined;
      const forkAgentId = typeof args.fork === "string" && args.fork ? args.fork : undefined;
      if (resumeAgentId && forkAgentId) {
        return 'ERROR: pass either "resume" or "fork", not both.';
      }
      const overrides: TaskCallOverrides = {
        readonly: typeof args.readonly === "boolean" ? args.readonly : undefined,
        model: typeof args.model === "string" && args.model ? args.model : undefined,
        resumeAgentId,
        forkAgentId,
        signal: ctx.signal,
      };
      const background = typeof args.background === "boolean" ? args.background : def.isBackground;
      if (background) {
        const jobId = opts.onBackgroundStart?.(def, prompt) ?? "";
        void opts
          .runSubagent(def, prompt, overrides)
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
      const result = await opts.runSubagent(def, prompt, overrides);
      const body = result.ok ? result.report : `Subagent "${def.name}" failed: ${result.report}`;
      // Handing the id back is what makes resume/fork reachable: the model has
      // no other way to name a transcript it never saw.
      return result.agentId
        ? `${body}\n\n(agent_id: ${result.agentId} — pass resume:"${result.agentId}" to continue this subagent, or fork:"${result.agentId}" to branch from it.)`
        : body;
    },
  };
}

