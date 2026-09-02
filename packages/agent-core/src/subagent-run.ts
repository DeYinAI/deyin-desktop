import { randomUUID } from "node:crypto";
import type { ApprovalMode, ChatMode } from "@deyin/host-core";
import { ASK_AGENT, BUILD_AGENT, DELIVERY_AGENT, PLAN_AGENT, type AgentDefinition } from "./agents.js";
import { runHooks, type LoadedHook } from "./capabilities/hooks.js";
import { runAgent, type AgentEvent } from "./loop.js";
import { PermissionEngine, type PermissionResolver, type PermissionRule } from "./permissions.js";
import { buildSystemPrompt } from "./prompt.js";
import { createBuiltinRegistry } from "./tools/index.js";
import type { ProviderApiFormat } from "./transports.js";
import type { SubagentStateStore } from "./subagent-state.js";
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

/**
 * Read-only for this run: the definition's own setting, or a per-call
 * `readonly: true` from the task tool. The two only ever compose one way — a
 * call may tighten a subagent, never loosen a definition the user marked
 * read-only.
 */
export function effectiveSubagentReadonly(
  def: Pick<SubagentDefinition, "readonly">,
  callOverride?: boolean,
): boolean {
  return def.readonly || callOverride === true;
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
  /** Step cap used when the definition has none; null = unlimited. */
  maxStepsDefault?: number | null;
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
  /** Per-call model from the task tool; the settings pin still outranks it. */
  callModel?: string;
  /** Effective read-only for this run; reported to hooks and stored on the record. */
  readonly?: boolean;
  /** Lifecycle hooks; subagentStart may block the run, subagentStop may append to it. */
  hooks?: LoadedHook[];
  /** Transcript store enabling resume/fork. Without it runs stay one-shot. */
  state?: SubagentStateStore;
  /** Thread/session that owns the transcript; a resume may not cross sessions. */
  sessionId?: string;
  /** Continue this transcript instead of starting clean. */
  resumeAgentId?: string;
  /** Branch from this transcript, leaving the source untouched. */
  forkAgentId?: string;
}

export interface SubagentRunResult {
  ok: boolean;
  report: string;
  /** Transcript id for a later resume/fork; absent when no state store is wired. */
  agentId?: string;
}

export interface ResolvedSubagentModel {
  model: string;
  providerId: string;
}

/**
 * Resolve the model + provider for a subagent run, most specific first:
 * the user's settings pin, then the model the calling agent asked for, then
 * the definition's frontmatter, then the parent's own model. The user's pin
 * outranks the model's per-call choice deliberately — a preference the user
 * set in settings should not be silently overridden by the agent.
 *
 * Pins and per-call values are "providerId::modelId"; a bare value targets
 * Openference, while a bare frontmatter `model:` keeps the parent's provider.
 */
export function resolveSubagentModel(
  def: Pick<SubagentDefinition, "model">,
  parent: { model: string; providerId: string },
  modelOverride?: string,
  callModel?: string,
): ResolvedSubagentModel {
  const explicit = modelOverride || callModel;
  if (explicit) {
    const sep = explicit.indexOf("::");
    const providerId = sep >= 0 ? explicit.slice(0, sep) : "openference";
    const model = sep >= 0 ? explicit.slice(sep + 2) : explicit;
    return { model, providerId };
  }
  if (def.model) {
    return { model: def.model, providerId: parent.providerId };
  }
  return { model: parent.model, providerId: parent.providerId };
}

/**
 * Chat-continuity invariants (do not break when adding subagents or UI):
 * 1. Subagent runs use their own messages[] — never append to the parent transcript.
 *    A resume/fork reuses the *child's* stored transcript, never the parent's.
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

  const systemPrompt = buildSystemPrompt({
    cwd,
    agent: { name: def.name, description: def.description, prompt: def.prompt },
  });

  const restored = restoreTranscript(def, req, systemPrompt);
  if ("error" in restored) return { ok: false, report: restored.error };
  const { agentId, messages, forkedFrom } = restored;
  messages.push({ role: "user", content: prompt });
  // Only advertise an id the model could actually resume: without a store the
  // transcript dies with the run, and offering `resume:"<id>"` for it would be
  // an affordance that always fails.
  const resumableId = req.state ? agentId : undefined;

  // Model + provider resolution (see resolveSubagentModel).
  const { model, providerId } = resolveSubagentModel(def, req.parent, req.modelOverride, req.callModel);
  let routing = req.parentRouting;
  if (providerId !== req.parent.providerId) {
    routing = req.resolveProvider?.(providerId) ?? req.parentRouting;
  }

  // subagentStart runs before any child work and may refuse it outright: this
  // is the one place a policy can stop delegated work that the parent's own
  // preToolUse hook cannot see into.
  if (req.hooks?.length) {
    const gate = await runHooks(req.hooks, "subagentStart", def.name, {
      subagent: def.name,
      agent_id: agentId,
      task: prompt,
      model,
      readonly: req.readonly ?? def.readonly,
      is_resume: Boolean(req.resumeAgentId),
      forked_from: forkedFrom,
      cwd,
    });
    if (gate.blocked) {
      return { ok: false, report: gate.reason ?? `Blocked by subagentStart hook.`, agentId: resumableId };
    }
  }

  const startedAt = Date.now();
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
    const report = result.finalText || "(subagent returned no text)";
    persistTranscript(def, req, agentId, messages, forkedFrom);
    return {
      ok: true,
      report: await withStopHook(req, def, agentId, report, {
        status: result.reason,
        ok: true,
        steps: result.steps,
        ms: Date.now() - startedAt,
      }),
      agentId: resumableId,
    };
  } catch (err) {
    const report = err instanceof Error ? err.message : String(err);
    // A failed run still persists: the transcript up to the failure is what a
    // resume needs in order to pick the work back up.
    persistTranscript(def, req, agentId, messages, forkedFrom);
    return {
      ok: false,
      report: await withStopHook(req, def, agentId, report, {
        status: "error",
        ok: false,
        ms: Date.now() - startedAt,
      }),
      agentId: resumableId,
    };
  }
}

interface RestoredTranscript {
  agentId: string;
  messages: AgentMessage[];
  forkedFrom?: string;
}

/**
 * The transcript this run starts from: a clean one, the one `resume` names, or
 * a copy of the one `fork` names.
 *
 * A resume keeps the same agent id (it *is* that agent, carrying on); a fork
 * gets a new one so the two branches never write over each other. Both are
 * refused across sessions and across subagent types — a transcript written by
 * one subagent in one thread is not context another may silently inherit.
 */
function restoreTranscript(
  def: SubagentDefinition,
  req: SubagentRunRequest,
  systemPrompt: string,
): RestoredTranscript | { error: string } {
  const sourceId = req.resumeAgentId ?? req.forkAgentId;
  if (!sourceId) {
    return {
      agentId: randomUUID(),
      messages: [{ role: "system", content: systemPrompt }],
    };
  }

  const verb = req.resumeAgentId ? "resume" : "fork";
  if (!req.state) {
    return { error: `ERROR: cannot ${verb} — this host does not persist subagent transcripts.` };
  }
  const record = req.state.load(sourceId);
  if (!record) {
    return { error: `ERROR: no subagent transcript found for agent_id "${sourceId}".` };
  }
  if (record.subagent !== def.name) {
    return {
      error: `ERROR: agent_id "${sourceId}" belongs to subagent "${record.subagent}", not "${def.name}".`,
    };
  }
  if (req.sessionId && record.sessionId && record.sessionId !== req.sessionId) {
    return { error: `ERROR: agent_id "${sourceId}" belongs to a different session.` };
  }

  // structuredClone keeps a fork from sharing message objects with its source.
  const messages: AgentMessage[] = structuredClone(record.messages);
  // The definition, cwd or tool list may have changed since the transcript was
  // written; rebuild the system prompt. Identical content is byte-identical, so
  // an unchanged prompt still hits the provider's prefix cache.
  if (messages[0]?.role === "system") messages[0] = { role: "system", content: systemPrompt };
  else messages.unshift({ role: "system", content: systemPrompt });

  return req.resumeAgentId
    ? { agentId: sourceId, messages, forkedFrom: record.forkedFrom }
    : { agentId: randomUUID(), messages, forkedFrom: sourceId };
}

function persistTranscript(
  def: SubagentDefinition,
  req: SubagentRunRequest,
  agentId: string,
  messages: AgentMessage[],
  forkedFrom?: string,
): void {
  if (!req.state) return;
  const now = Date.now();
  const previous = req.resumeAgentId ? req.state.load(agentId) : undefined;
  req.state.save({
    agentId,
    subagent: def.name,
    sessionId: req.sessionId ?? "",
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    ...(forkedFrom ? { forkedFrom } : {}),
    messages,
  });
}

/**
 * Run subagentStop and fold anything it returns into the report. A stop hook
 * cannot block (the work is already done), so its `additional_context` is the
 * useful channel: house rules, a follow-up instruction, a lint of the result.
 */
async function withStopHook(
  req: SubagentRunRequest,
  def: SubagentDefinition,
  agentId: string,
  report: string,
  outcome: { status: string; ok: boolean; steps?: number; ms: number },
): Promise<string> {
  if (!req.hooks?.length) return report;
  const stop = await runHooks(req.hooks, "subagentStop", def.name, {
    subagent: def.name,
    agent_id: agentId,
    status: outcome.status,
    ok: outcome.ok,
    steps: outcome.steps,
    duration_ms: outcome.ms,
    summary: report.slice(0, 2000),
    cwd: req.cwd,
  });
  const followups = (stop.additionalContext ?? []).filter((line) => line.trim().length > 0);
  return followups.length > 0 ? `${report}\n\n${followups.join("\n")}` : report;
}
