import type { ApprovalMode, ChatMode } from "@deyin/host-core";
import { ASK_AGENT, BUILD_AGENT, DELIVERY_AGENT, PLAN_AGENT, type AgentDefinition } from "./agents.js";
import { runAgent, type AgentEvent } from "./loop.js";
import { PermissionEngine, type PermissionResolver, type PermissionRule } from "./permissions.js";
import { buildSystemPrompt } from "./prompt.js";
import { createBuiltinRegistry } from "./tools/index.js";
import type { ProviderApiFormat } from "./transports.js";
import type { ImageGenBridge, ToolDefinition, AgentMessage } from "./types.js";
import type { SubagentDefinition } from "./capabilities/subagents.js";

/**
 * Read-only tool rules for parent runs in read-only mode and plan/ask agents.
 * Canonical copy shared by every host (desktop, automations, CLI).
 */
export const READONLY_RULES: PermissionRule[] = [
  { tool: "*", action: "deny" },
  { tool: "read", action: "allow" },
  { tool: "grep", action: "allow" },
  { tool: "glob", action: "allow" },
  { tool: "ls", action: "allow" },
  { tool: "websearch", action: "allow" },
  { tool: "web_fetch", action: "allow" },
  { tool: "todo_write", action: "allow" },
  { tool: "todo_read", action: "allow" },
  { tool: "ask_question", action: "allow" },
  { tool: "create_plan", action: "allow" },
  { tool: "enter_plan_mode", action: "allow" },
  { tool: "exit_plan_mode", action: "allow" },
  { tool: "switch_mode", action: "allow" },
  { tool: "skill", action: "allow" },
  { tool: "read_session_context", action: "allow" },
  { tool: "send_message", action: "allow" },
  { tool: "memory", action: "allow" },
  { tool: "codebase_search", action: "allow" },
  { tool: "browser_snapshot", action: "allow" },
  { tool: "browser_screenshot", action: "allow" },
  { tool: "browser_console", action: "allow" },
  { tool: "browser_network", action: "allow" },
];

/** Permission rules for a parent approval mode (desktop semantics). */
export function rulesForApprovalMode(mode: ApprovalMode): PermissionRule[] {
  switch (mode) {
    case "full-access":
    case "ask-first":
      return [];
    case "read-only":
      return READONLY_RULES;
  }
}

/**
 * Whether a run may skip every permission prompt. "Full access" means exactly
 * that: whatever the composer mode, nothing is ever put in front of the user.
 * The composer mode still restricts what may run — plan/ask deny rules (and any
 * explicit user deny rule) beat skipAll — so read-only modes stay read-only;
 * they just deny instead of prompting. Shared by the desktop host, the web host
 * and their subagents so all three agree.
 */
export function skipPromptsForApproval(approvalMode: ApprovalMode, _mode: ChatMode): boolean {
  return approvalMode === "full-access";
}

/** Built-in agent backing each composer mode. */
export function agentForMode(mode: ChatMode): AgentDefinition {
  switch (mode) {
    case "plan":
      return PLAN_AGENT;
    case "ask":
      return ASK_AGENT;
    case "delivery":
      return DELIVERY_AGENT;
    default:
      return BUILD_AGENT;
  }
}

/** Definition-level readonly rules: write/edit denied, bash asks. */
export function subagentReadonlyRules(def: Pick<SubagentDefinition, "readonly">): PermissionRule[] {
  return def.readonly
    ? [
        { tool: "write", action: "deny" },
        { tool: "edit", action: "deny" },
        { tool: "bash", action: "ask" },
      ]
    : [];
}

export interface SubagentProviderRouting {
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
  /** Provider wire format (chat-completions | responses | anthropic). */
  apiFormat?: ProviderApiFormat;
  /** Anthropic-compatible gateways using Bearer instead of x-api-key. */
  authHeader?: boolean;
}

export interface SubagentRunRequest {
  cwd: string;
  parent: {
    model: string;
    providerId: string;
    thinking?: boolean;
  };
  /** settings/config override: "providerId::modelId" or a bare model id. */
  modelOverride?: string;
  /** settings/config effort override, already normalized (low|medium|high). */
  effortOverride?: "low" | "medium" | "high";
  /** maxSteps used when the definition has none. */
  maxStepsDefault?: number;
  /** The parent run's current routing; used when no provider switch happens. */
  parentRouting: SubagentProviderRouting;
  /** Route an arbitrary provider id to endpoint + token source. */
  resolveProvider?: (providerId: string) => SubagentProviderRouting | undefined;
  permissionEngine: PermissionEngine;
  resolvePermission: PermissionResolver;
  /** Host tools (codebase search, browser, …) added before allowlist filtering. */
  extraTools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Live observation of the child run (used for subagent progress lines). */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Parent's image bridge. Passed on so a subagent asked for icons or mockups
   * can draw; without it generate_image is dropped from the child's toolset.
   */
  imageGen?: ImageGenBridge;
  /**
   * Parent's wire options (compression + prompt caching). Passed on so child
   * runs get the same token savings as the parent; hosts set this alongside
   * their own runAgent call.
   */
  wire?: import("./wire.js").WireOptions;
}

export interface SubagentRunResult {
  ok: boolean;
  report: string;
}

export interface ResolvedSubagentModel {
  model: string;
  providerId: string;
}

/**
 * Resolve the model + provider for a subagent run. Settings overrides store
 * "providerId::modelId"; a bare override value targets Openference, and a bare
 * frontmatter `model:` keeps the parent's provider.
 */
export function resolveSubagentModel(
  _def: Pick<SubagentDefinition, "model">,
  parent: { model: string; providerId: string },
  modelOverride?: string,
): ResolvedSubagentModel {
  if (modelOverride) {
    const sep = modelOverride.indexOf("::");
    const providerId = sep >= 0 ? modelOverride.slice(0, sep) : "openference";
    const model = sep >= 0 ? modelOverride.slice(sep + 2) : modelOverride;
    return { model, providerId };
  }
  // Inherit uses the parent run's composer model, not the subagent frontmatter default.
  return { model: parent.model, providerId: parent.providerId };
}

/**
 * Chat-continuity invariants (do not break when adding subagents or UI):
 * 1. Subagent runs use a fresh messages[] — never append to the parent transcript.
 * 2. Only the final report string returns to the parent (via the task tool result).
 * 3. Foreground task calls await completion before the parent loop continues.
 * 4. Subagents have no nested task tool (max delegation depth 2).
 * 5. UI shows inline subagent cards; full activity lives in the Agent panel side channel.
 *
 * Clean-context subagent run shared by every host (desktop, automations, CLI).
 * Builds the registry (builtins + host tools + `tools:` allowlist filter), the
 * system prompt from the definition, resolves the model + provider (settings
 * overrides are "providerId::modelId" and route to that provider), and runs the
 * loop with a stable prompt-cache key so repeated delegations reuse the prefix
 * cache. Never throws: failures surface as { ok: false, report }.
 */
export async function runSubagent(
  def: SubagentDefinition,
  prompt: string,
  req: SubagentRunRequest,
): Promise<SubagentRunResult> {
  const cwd = req.cwd;
  // Subagents get the built-in toolset (no nested task tool → max depth 2).
  let registry = createBuiltinRegistry();
  for (const tool of req.extraTools ?? []) registry.register(tool);
  if (def.tools && def.tools.length > 0) registry = registry.filtered(def.tools);
  // No image bridge from the parent: the child cannot draw, so do not offer it.
  if (!req.imageGen) registry.unregister("generate_image");

  const messages: AgentMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        cwd,
        agent: { name: def.name, description: def.description, prompt: def.prompt },
        toolNames: registry.names(),
      }),
    },
    { role: "user", content: prompt },
  ];

  // Model + provider resolution (see resolveSubagentModel).
  const { model, providerId } = resolveSubagentModel(def, req.parent, req.modelOverride);
  let routing = req.parentRouting;
  if (providerId !== req.parent.providerId) {
    routing = req.resolveProvider?.(providerId) ?? req.parentRouting;
  }

  try {
    const result = await runAgent({
      apiBaseUrl: routing.apiBaseUrl,
      getToken: routing.getToken,
      apiFormat: routing.apiFormat,
      authHeader: routing.authHeader,
      model,
      maxSteps: def.maxSteps ?? req.maxStepsDefault,
      effort: req.effortOverride ?? def.effort,
      promptCacheKey: `deyin-subagent:${def.name}:${model}:${cwd}`,
      ...(req.wire ? { wire: { ...req.wire, model } } : {}),
      messages,
      tools: registry,
      permissions: req.permissionEngine,
      resolvePermission: req.resolvePermission,
      cwd,
      thinking: req.parent.thinking,
      signal: req.signal,
      onEvent: req.onEvent,
      ...(req.imageGen ? { toolContext: { imageGen: req.imageGen } } : {}),
    });
    return { ok: true, report: result.finalText || "(subagent returned no text)" };
  } catch (err) {
    return { ok: false, report: err instanceof Error ? err.message : String(err) };
  }
}
