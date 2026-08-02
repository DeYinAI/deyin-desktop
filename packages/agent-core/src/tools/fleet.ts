import type { SubagentDefinition } from "../capabilities/subagents.js";
import type { ToolDefinition } from "../types.js";
import type { AcquireRequest } from "../scheduler/subagent-scheduler.js";
import {
  normalizeWritePaths,
  validateNonOverlappingWriteClaims,
  wholeWorkspaceWriteClaim,
  writePathSetEmpty,
  type WritePathSet,
} from "../scheduler/write-claims.js";
import type { TaskRunResult } from "./task.js";
import { asString } from "./util.js";

export interface FleetTaskSpec {
  profile?: string;
  prompt: string;
  write_paths?: string[];
  read_only?: boolean;
  model?: string;
}

export interface FleetToolOptions {
  subagents: SubagentDefinition[];
  cwd: string;
  runSubagent: (
    def: SubagentDefinition,
    prompt: string,
    opts: { writePaths?: WritePathSet; signal?: AbortSignal; nested?: boolean },
  ) => Promise<TaskRunResult>;
  acquireSlot?: (req: AcquireRequest, signal?: AbortSignal) => Promise<() => void>;
  /** When false, skip overlapping write_paths preflight (not recommended). */
  validateWritePaths?: boolean;
  onFleetEvent?: (event: { kind: "preflight" | "start" | "complete" | "conflict"; detail: string; taskCount: number }) => void;
}

type FleetItemStatus = "pending" | "completed" | "failed" | "skipped";

interface FleetItemResult {
  index: number;
  status: FleetItemStatus;
  profile?: string;
  output: string;
  error?: string;
}

const FLEET_MIN = 2;
const FLEET_MAX = 64;

function resolveSubagent(subagents: SubagentDefinition[], profile?: string): SubagentDefinition | undefined {
  if (!profile) return subagents[0];
  return subagents.find((s) => s.name === profile.toLowerCase());
}

function formatFleetAggregate(results: FleetItemResult[]): string {
  const n = results.length;
  let out = `Completed fleet of ${n} tasks:\n`;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    out += `── task-${i + 1}`;
    if (r.profile) out += ` profile=${r.profile}`;
    out += " ──\n";
    switch (r.status) {
      case "completed":
        out += `status: completed\n${r.output.trim()}\n`;
        break;
      case "failed":
        out += `status: failed\n[FAILED] ${r.error ?? r.output}\n`;
        break;
      case "skipped":
        out += `status: skipped\n[SKIPPED] ${r.error ?? "not started"}\n`;
        break;
      default:
        out += "status: pending\n";
    }
  }
  return out;
}

/**
 * Fleet tool for coordinated parallel execution with write-path preflight.
 */
export function createFleetTool(opts: FleetToolOptions): ToolDefinition {
  return {
    name: "fleet",
    description:
      "Execute 2–64 tasks in parallel with write-path coordination. Each task can specify a profile, write_paths, and read_only. " +
      "Parallel writers must declare non-overlapping write_paths; omitting write_paths on a writer claims the whole workspace.",
    tier: "execute",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              profile: { type: "string", description: "Subagent profile name." },
              prompt: { type: "string", description: "Task prompt." },
              write_paths: {
                type: "array",
                items: { type: "string" },
                description: "Files this task will modify.",
              },
              read_only: { type: "boolean", description: "Force read-only execution." },
              model: { type: "string", description: "Optional model override." },
            },
            required: ["prompt"],
          },
          minItems: FLEET_MIN,
          maxItems: FLEET_MAX,
        },
      },
      required: ["tasks"],
    },
    summarize: (args) => {
      const tasks = (args.tasks as FleetTaskSpec[] | undefined) ?? [];
      return `fleet (${tasks.length} tasks)`;
    },
    async execute(args, ctx): Promise<string> {
      const tasks = (args.tasks as FleetTaskSpec[] | undefined) ?? [];
      if (tasks.length < FLEET_MIN || tasks.length > FLEET_MAX) {
        return `ERROR: fleet requires between ${FLEET_MIN} and ${FLEET_MAX} tasks (got ${tasks.length}).`;
      }

      const claims: WritePathSet[] = [];
      const specs: Array<{ def: SubagentDefinition; prompt: string; claim: WritePathSet; readOnly: boolean }> = [];

      for (let i = 0; i < tasks.length; i++) {
        const item = tasks[i]!;
        const prompt = asString(item.prompt, "prompt");
        const readOnly = item.read_only === true;
        const def = resolveSubagent(opts.subagents, item.profile);
        if (!def) {
          const names = opts.subagents.map((s) => s.name).join(", ");
          return `ERROR: task ${i + 1}: unknown profile "${item.profile ?? ""}". Available: ${names}.`;
        }

        let claim: WritePathSet = { paths: [], wholeWorkspace: false, workspaceRoot: opts.cwd };
        const isWriter = !readOnly && !def.readonly;
        if (isWriter) {
          if (item.write_paths && item.write_paths.length > 0) {
            try {
              claim = normalizeWritePaths(opts.cwd, item.write_paths);
            } catch (err) {
              return `ERROR: task ${i + 1}: ${err instanceof Error ? err.message : String(err)}`;
            }
          } else {
            try {
              claim = wholeWorkspaceWriteClaim(opts.cwd);
            } catch (err) {
              return `ERROR: task ${i + 1}: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
        }
        claims[i] = claim;
        specs.push({ def, prompt, claim, readOnly: readOnly || def.readonly });
      }

      try {
        if (opts.validateWritePaths !== false) {
          validateNonOverlappingWriteClaims(claims);
        }
        opts.onFleetEvent?.({ kind: "preflight", detail: "write_paths validated", taskCount: tasks.length });
      } catch (err) {
        opts.onFleetEvent?.({
          kind: "conflict",
          detail: err instanceof Error ? err.message : String(err),
          taskCount: tasks.length,
        });
        return `ERROR: fleet preflight: ${err instanceof Error ? err.message : String(err)}`;
      }

      opts.onFleetEvent?.({ kind: "start", detail: "parallel execution", taskCount: tasks.length });

      const results: FleetItemResult[] = specs.map((s, i) => ({
        index: i,
        status: "pending" as FleetItemStatus,
        profile: s.def.name,
        output: "",
      }));

      await Promise.all(
        specs.map(async (spec, index) => {
          if (ctx.signal?.aborted) {
            results[index]!.status = "skipped";
            results[index]!.error = "aborted";
            return;
          }

          let release: (() => void) | undefined;
          try {
            if (opts.acquireSlot) {
              const writer = !spec.readOnly;
              release = await opts.acquireSlot(
                {
                  writer,
                  writePaths: spec.claim,
                  nested: true,
                  label: `fleet-${index + 1}`,
                },
                ctx.signal,
              );
            }

            const result = await opts.runSubagent(spec.def, spec.prompt, {
              writePaths: writePathSetEmpty(spec.claim) ? undefined : spec.claim,
              signal: ctx.signal,
              nested: true,
            });

            results[index] = {
              index,
              status: result.ok ? "completed" : "failed",
              profile: spec.def.name,
              output: result.report,
              error: result.ok ? undefined : result.report,
            };
          } catch (err) {
            results[index] = {
              index,
              status: "failed",
              profile: spec.def.name,
              output: "",
              error: err instanceof Error ? err.message : String(err),
            };
          } finally {
            release?.();
          }
        }),
      );

      const completed = results.filter((r) => r.status === "completed").length;
      opts.onFleetEvent?.({
        kind: "complete",
        detail: `${completed}/${results.length} tasks completed`,
        taskCount: results.length,
      });

      return formatFleetAggregate(results);
    },
  };
}
