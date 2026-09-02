import { homedir } from "node:os";
import { join } from "node:path";
import {
  PermissionEngine,
  createTaskTool,
  discoverSubagents,
  getSessionJobsManager,
  runSubagent,
  effectiveSubagentReadonly,
  getSubagentStateStore,
  subagentReadonlyRules,
  subagentRoots,
  type LoadedHook,
  type PermissionResolver,
  type SubagentDefinition,
  type ToolRegistry,
} from "@deyin/agent-core";
import type { CliContext } from "./context.js";
import { tokenSource } from "./context.js";

/** Discover subagents the CLI can delegate to: built-ins + workspace/user .deyin/agents. */
export async function loadCliSubagents(ctx: CliContext): Promise<SubagentDefinition[]> {
  return discoverSubagents(subagentRoots(ctx.cwd, homedir()));
}

export interface CliSubagentToolOptions {
  ctx: CliContext;
  /** Active session id for background job tracking (may start empty). */
  sessionId: () => string | null;
  /** --yes semantics: skip permission prompts for non-readonly subagents. */
  skipAll: boolean;
  /** Loaded lifecycle hooks; subagentStart/subagentStop fire from these. */
  hooks?: LoadedHook[];
  resolvePermission: PermissionResolver;
  onBackgroundDone?: (jobId: string, def: SubagentDefinition, result: { ok: boolean; report: string }) => void;
}

/**
 * Register the `task` tool (clean-context subagent delegation) on a CLI tool
 * registry. Subagent definitions are shared with the desktop (same .md files),
 * and the run uses the same shared runner semantics: model overrides from
 * config, readonly rules, tools allowlist, step caps, stable prompt-cache key.
 */
export async function registerCliSubagentTool(tools: ToolRegistry, opts: CliSubagentToolOptions): Promise<void> {
  const subagents = await loadCliSubagents(opts.ctx);
  if (subagents.length === 0) return;
  const ctx = opts.ctx;
  const jobsDir = join(ctx.dataDir, "jobs");
  tools.register(
    createTaskTool({
      subagents,
      runSubagent: (def, prompt, overrides) => {
        const routing = { apiBaseUrl: ctx.config.apiBaseUrl, getToken: tokenSource(ctx) };
        // A call may tighten a subagent to read-only; it can never loosen one.
        const readonly = effectiveSubagentReadonly(def, overrides.readonly);
        return runSubagent(def, prompt, {
          cwd: ctx.cwd,
          parent: { model: ctx.config.model, providerId: "openference", thinking: ctx.config.thinking },
          modelOverride: ctx.config.subagentModels[def.name],
          callModel: overrides.model,
          effortOverride: undefined,
          maxStepsDefault: ctx.config.subagentMaxSteps,
          parentRouting: routing,
          // The CLI is Openference-only (plus DEYIN_* env); custom-provider
          // overrides fall back to the parent routing.
          resolveProvider: (providerId) => (providerId === "openference" ? routing : undefined),
          permissionEngine: new PermissionEngine({
            agentRules: [],
            configRules: [...ctx.config.permissions, ...subagentReadonlyRules({ readonly })],
            skipAll: opts.skipAll && !readonly,
          }),
          resolvePermission: opts.resolvePermission,
          readonly,
          hooks: opts.hooks,
          // Transcripts live beside the CLI's jobs log, so resume/fork works
          // across separate `deyin` invocations in the same session.
          state: getSubagentStateStore(ctx.dataDir),
          sessionId: opts.sessionId() ?? undefined,
          resumeAgentId: overrides.resumeAgentId,
          forkAgentId: overrides.forkAgentId,
          signal: overrides.signal,
        });
      },
      onBackgroundStart: (def, subPrompt) => {
        const sessionId = opts.sessionId();
        if (!sessionId) return "";
        return getSessionJobsManager(sessionId, jobsDir).register({
          kind: "task",
          label: def.name,
          prompt: subPrompt,
        }).id;
      },
      onBackgroundDone: (jobId, def, result) => {
        const sessionId = opts.sessionId();
        if (sessionId && jobId) {
          getSessionJobsManager(sessionId, jobsDir).updateStatus(
            jobId,
            result.ok ? "completed" : "failed",
            result.ok ? result.report : undefined,
            result.ok ? undefined : result.report,
          );
        }
        opts.onBackgroundDone?.(jobId, def, result);
      },
    }),
  );
}
