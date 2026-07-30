/**
 * Plugin hooks bridging Semantic Optimization into the agent loop.
 */

import type { AgentToolCall } from "@deyin/agent-core";
import type { ResponseCache } from "./response-cache.js";
import type { ToolResultCache } from "./tool-cache.js";

export interface OptimizationHooksConfig {
 enableToolCache: boolean;
 enableResponseCache: boolean;
}

export interface OptimizationRuntime {
 toolCache: ToolResultCache;
 responseCache: ResponseCache;
 config: OptimizationHooksConfig;
}

export interface ResponseCacheContext {
 /** Provider model id (e.g. "gpt-4o"). */
 model: string;
 /** Composer mode (agent / plan / ask). */
 mode: string;
 /** Hash of the system prompt — distinguishes agent/persona/context changes. */
 systemPromptHash: string;
 /** Hash of recent user/assistant turns — prevents wrong-answer replay across threads. */
 historyHash: string;
}

/**
 * Combine workspaceId with cache context into a namespaced key so the same
 * wording under a different model, mode, system prompt, or conversation
 * history does not replay the wrong answer.
 */
function namespacedWorkspace(workspaceId: string, context?: ResponseCacheContext): string {
 if (!context) return workspaceId;
 return `${workspaceId}|${context.model}|${context.mode}|${context.systemPromptHash}|${context.historyHash}`;
}

export async function beforeAgentRun(
 runtime: OptimizationRuntime,
 query: string,
 workspaceId: string,
 context?: ResponseCacheContext,
): Promise<{ hit: true; response: string } | { hit: false }> {
 if (!runtime.config.enableResponseCache) return { hit: false };
 const cached = await runtime.responseCache.get(query, namespacedWorkspace(workspaceId, context));
 if (!cached) return { hit: false };
 return { hit: true, response: cached.response };
}

export async function afterAgentRun(
 runtime: OptimizationRuntime,
 query: string,
 response: string,
 workspaceId: string,
 context?: ResponseCacheContext,
): Promise<void> {
 if (!runtime.config.enableResponseCache) return;
 await runtime.responseCache.set(query, response, namespacedWorkspace(workspaceId, context));
}

export async function beforeToolExecution(
  runtime: OptimizationRuntime,
  call: AgentToolCall,
  args: Record<string, unknown>,
): Promise<string | null> {
  if (!runtime.config.enableToolCache) return null;
  const entry = await runtime.toolCache.get(call.name, args);
  return entry?.result ?? null;
}

export async function afterToolExecution(
  runtime: OptimizationRuntime,
  call: AgentToolCall,
  args: Record<string, unknown>,
  result: string,
  ok: boolean,
): Promise<void> {
  if (!runtime.config.enableToolCache || !ok) return;
  await runtime.toolCache.set(call.name, args, result);
}

export function onWorkspaceFileChanged(runtime: OptimizationRuntime, path: string): void {
  // Tool results reference file paths directly, so path-based invalidation
  // is correct and necessary after edits.
  runtime.toolCache.invalidatePath(path);
  // The response cache is intentionally NOT path-invalidated here:
  //  - cached answers are namespaced by systemPromptHash, so edits to
  //    context files (AGENTS.md/CLAUDE.md) already bust the cache via a
  //    new hash on the next run
  //  - arbitrary code edits don't change the answer to a semantically
  //    identical question, and nuking the cache on every edit would
  //    defeat its purpose
  // Use responseCache.clear() / invalidateWorkspace() for explicit resets.
}
