import { homedir } from "node:os";
import {
  PermissionEngine,
  createTaskTool,
  discoverSubagents,
  runSubagent,
  subagentReadonlyRules,
  subagentRoots,
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
  /** --yes semantics: skip permission prompts for non-readonly subagents. */
  skipAll: boolean;
  resolvePermission: PermissionResolver;
  onBackgroundDone?: (def: SubagentDefinition, result: { ok: boolean; report: string }) => void;
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
  tools.register(
    createTaskTool({
      subagents,
      runSubagent: (def, prompt, signal) => {
        const routing = { apiBaseUrl: ctx.config.apiBaseUrl, getToken: tokenSource(ctx) };
        return runSubagent(def, prompt, {
          cwd: ctx.cwd,
          parent: { model: ctx.config.model, providerId: "openference", thinking: ctx.config.thinking },
          modelOverride: ctx.config.subagentModels[def.name],
          effortOverride: undefined,
          maxStepsDefault: ctx.config.subagentMaxSteps,
          parentRouting: routing,
          // The CLI is Openference-only (plus DEYIN_* env); custom-provider
          // overrides fall back to the parent routing.
          resolveProvider: (providerId) => (providerId === "openference" ? routing : undefined),
          permissionEngine: new PermissionEngine({
            agentRules: [],
            configRules: [...ctx.config.permissions, ...subagentReadonlyRules(def)],
            skipAll: opts.skipAll && !def.readonly,
          }),
          resolvePermission: opts.resolvePermission,
          signal,
        });
      },
      onBackgroundDone: opts.onBackgroundDone,
    }),
  );
}
