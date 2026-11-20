import { SessionStore } from "@deyin/agent-core";
import { join } from "node:path";
import { app } from "electron";
import { createTaskTool, runAgent, runHooks, runSubagent, subagentEffort } from "@deyin/agent-core";
import type { AgentMessage, ToolRegistry } from "@deyin/agent-core";
import type { Automation, AutomationLimits } from "@deyin/host-core";
import type { SubagentDefinition } from "@deyin/agent-core";
import type { AgentUiEvent } from "@deyin/contract";
import {
  automationPermissions,
  buildAutomationEnvironment,
  buildAutomationSystemPrompt,
  closeMcp,
  type AgentRunContextDeps,
} from "./agent-run-context.js";
import { automationRequiresExtraConfirmation } from "../permission-policy.js";
import { chatPersona, withBotPersona, type BotRunContext, type BotRunSource } from "../bots/run.js";
import { allowRoomDelegation, primaryDelegation } from "../bots/room-run.js";
import { createBotRunGuard } from "../bots/run-guard.js";
import { createVaultRun, type VaultRun } from "../bots/vault-run.js";
import { browserPageSource } from "../bots/vault-pages.js";
import { automationThreadId, consentOrigins } from "./consent.js";
import { buildRunPrompt } from "./run-prompt.js";
import { guardToolCall } from "./tool-guard.js";
import { checkRequiredTools } from "./health.js";
import { createRunTools, type AutomationStateAccess, type ReportedOutcome } from "./run-tools.js";

/** Sent once when a run's agent loop ends without it having reported how the run went. */
export const REPORT_REMINDER =
  "You stopped without calling automation_report. Call it now, once, with what actually happened: the outcome, a short summary, and the blocker if you were blocked. Do nothing else.";

export interface LocalRunOptions {
  automation: Automation;
  /** Payload already resolved to text (see payload.ts). */
  prompt: string;
  /** Set when the payload names a subagent: delegate in-process instead. */
  subagent?: SubagentDefinition;
  cwd: string;
  /** The bounds this run is held to; `maxSteps` is enforced here, the clocks by the runner. */
  limits: AutomationLimits;
  /** When the run began, for the run clock the model sees. */
  startedAt: number;
  onEvent: (event: AgentUiEvent) => void;
  /** Called for every sign of life, including streaming tool output the UI never sees. */
  onActivity?: () => void;
  /** The automation's saved state, when it has one to offer. */
  state?: AutomationStateAccess;
  /** Set for a Bot's routine: the run takes on the Bot's persona and memory, and works in its folder (`cwd`). */
  bot?: BotRunContext;
  /** Where the Bot's mode and saved permissions are read from. A Bot's routine cannot run without it. */
  botSource?: BotRunSource;
  signal?: AbortSignal;
}

export interface LocalRunResult {
  reason: "completed" | "max-steps" | "aborted";
  finalText: string;
  /** What the run said about how it went, if it said anything. */
  report?: ReportedOutcome;
}

export async function runLocalAutomation(
  deps: AgentRunContextDeps,
  opts: LocalRunOptions,
): Promise<LocalRunResult> {
  const { automation, prompt, cwd, onEvent, signal, limits } = opts;
  const browserOrigins = consentOrigins(automation);
  const env = await buildAutomationEnvironment(deps, cwd, automation.providerId, { browserOrigins, ...(opts.bot ? { excludeWorkspaceCaps: true, botSkillsDir: opts.bot.skills.root } : {}) });
  const settings = deps.settings.get();

  // A Bot's routine is held to the Bot's own permissions, the same as its chat. Nobody is watching, so anything
  // that would need a person is refused rather than waited on. Without the Bot's settings it does not run at all.
  if (opts.bot && !opts.botSource) {
    await closeMcp(env.mcpConnections);
    throw new Error("A Bot's routine cannot run without the Bot's permissions.");
  }
  const botGuard =
    opts.bot && opts.botSource
      ? createBotRunGuard({
          source: opts.botSource,
          botId: opts.bot.bot.id,
          tierOf: (name) => env.registry.get(name)?.tier,
          reviewer: {
            apiBaseUrl: env.provider.apiBaseUrl,
            getToken: env.provider.getToken,
            model: automation.model,
            contextLength: deps.getContextLength(automation.providerId, automation.model),
            cwd,
          },
        })
      : undefined;

  // The person's primary Bot hands work to the Bots it coordinates in a routine as it does in a chat: each answers
  // as itself, held to the same guard. Nobody is there to approve anything, so whatever would need a person is refused.
  const delegation =
    opts.bot && opts.botSource && !opts.subagent
      ? await primaryDelegation(opts.bot.bot, opts.botSource, { memoryEnabled: settings.memoryEnabled })
      : undefined;
  const parentGuard = botGuard && delegation ? allowRoomDelegation(botGuard, delegation.team.bots) : botGuard;

  // A Bot's routine can fill saved logins, cards and contacts too, but nobody is here to agree to anything new: it
  // only uses what a person already agreed to, and anything it reads is scrubbed of what the Vault holds.
  const vaultRun: VaultRun | undefined =
    opts.bot && opts.botSource?.vault
      ? createVaultRun({
          vault: opts.botSource.vault,
          botId: opts.bot.bot.id,
          pages: {
            ...(env.registry.get("browser_snapshot") ? { browser: browserPageSource(deps.browser) } : {}),
            ...(env.registry.get("chrome_snapshot") && deps.chromePages ? { chrome: deps.chromePages } : {}),
          },
        })
      : undefined;
  if (vaultRun) for (const tool of vaultRun.tools()) env.registry.register(tool);

  // What the run needs, checked before a model is paid for: a missing tool is a blocker, not something to improvise around.
  if (!opts.subagent) {
    const blocker = checkRequiredTools(automation.requires, env.registry.names(), () => {
      const failed = env.mcpFailures.map((f) => `MCP server "${f.server}" ${f.needsAuth ? "needs you to sign in" : `would not connect (${f.message})`}.`);
      return failed.length > 0 ? failed.join(" ") : undefined;
    });
    if (blocker) {
      await closeMcp(env.mcpConnections);
      onEvent({ type: "error", message: blocker.detail });
      onEvent({ type: "done", reason: "completed", finalText: blocker.detail });
      return { reason: "completed", finalText: blocker.detail, report: { outcome: "blocked", summary: blocker.detail, blocker } };
    }
  }

  // How a child run (the subagent a payload names, or a Bot the primary hands work to) is set up. A delegate's words
  // are its own report, not the routine's text, so only a payload's subagent streams them.
  const childRequest = (def: SubagentDefinition, streamText: boolean): Parameters<typeof runSubagent>[2] => ({
    cwd,
    parent: { model: automation.model, providerId: automation.providerId, thinking: settings.thinking },
    modelOverride: settings.subagentModels[def.name],
    effortOverride: subagentEffort(settings.subagentEfforts[def.name], def.effort),
    maxStepsDefault: Math.min(limits.maxSteps, settings.subagentMaxSteps),
    parentRouting: { apiBaseUrl: env.provider.apiBaseUrl, getToken: env.provider.getToken },
    permissionEngine: automationPermissions(),
    resolvePermission: async (req) => {
      if (automationRequiresExtraConfirmation(req.toolName, req.args)) return "deny";
      return "allow";
    },
    ...(botGuard ? { beforeTool: botGuard } : {}),
    // A routine's subagent has no browser, so no Vault tools either; what it reads is still scrubbed.
    ...(vaultRun ? { prepareRegistry: (registry: ToolRegistry) => vaultRun.protect(registry) } : {}),
    signal,
    onEvent: (event) => {
      opts.onActivity?.();
      if (event.type === "text-delta") {
        if (streamText) onEvent({ type: "text-delta", delta: event.delta });
      } else if (event.type === "tool-start") {
        onEvent({ type: "tool-start", callId: event.call.id, name: event.call.name, summary: event.summary });
      } else if (event.type === "tool-end") {
        onEvent({
          type: "tool-end",
          callId: event.call.id,
          name: event.call.name,
          summary: "",
          result: event.result.length > 8_000 ? `${event.result.slice(0, 8_000)}\n… (truncated)` : event.result,
          ok: event.ok,
          denied: event.denied,
        });
      } else if (event.type === "file-change") {
        onEvent({
          type: "file-change",
          path: event.change.path,
          before: event.change.before,
          after: event.change.after,
        });
      }
    },
  });

  let steps = 0;
  const runTools = createRunTools({ startedAt: opts.startedAt, limits, steps: () => steps }, opts.state);
  for (const tool of runTools.tools) env.registry.register(tool);
  if (delegation) {
    env.registry.register(
      createTaskTool({
        subagents: delegation.delegates,
        runSubagent: (def, subPrompt, overrides) => runSubagent(overrides.readonly ? { ...def, readonly: true } : def, subPrompt, childRequest(def, false)),
      }),
    );
  }
  vaultRun?.protect(env.registry);
  const system = await buildAutomationSystemPrompt(
    deps,
    cwd,
    withBotPersona(
      buildRunPrompt({ startedAt: opts.startedAt, limits, browserOrigins, learnedRules: automation.learnedRules, ...(opts.state ? { state: opts.state.get() ?? null } : {}) }),
      // A routine starts from what the Bot was told: its job and its rules are in front of it, as in a chat.
      opts.bot ? chatPersona(opts.bot.persona, { ...(delegation ? { team: delegation.team } : {}), facts: settings.memoryEnabled ? opts.bot.memory.list() : [], unattended: true }) : undefined,
    ),
    { excludeWorkspaceCaps: opts.bot !== undefined, ...(opts.bot ? { botSkillsDir: opts.bot.skills.root } : {}) },
  );
  const messages: AgentMessage[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];

  // A subagent payload delegates directly rather than asking the model to call the task tool (only a primary
  // Bot's routine has one, for the Bots it coordinates), and runSubagent already gives the child a clean context
  // and its own toolset.
  if (opts.subagent) {
    const def = opts.subagent;
    const result = await runSubagent(def, prompt, childRequest(def, true));
    await closeMcp(env.mcpConnections);
    if (!result.ok) onEvent({ type: "error", message: result.report });
    onEvent({ type: "done", reason: result.ok ? "completed" : "aborted", finalText: result.report });
    return { reason: result.ok ? "completed" : "aborted", finalText: result.report };
  }

  const store = new SessionStore(join(app.getPath("userData"), "automation-sessions"));
  const meta = store.create({ cwd, model: automation.model, agent: "automation" });
  for (const message of messages) store.append(meta.id, message);

  const emit = (event: AgentUiEvent): void => onEvent(event);

  const turn = (tools: ToolRegistry, maxSteps: number, withMemory: boolean) =>
    runAgent({
      apiBaseUrl: env.provider.apiBaseUrl,
      getToken: env.provider.getToken,
      model: automation.model,
      // The automation's own bound, not the interactive setting: an unattended run needs a ceiling.
      maxSteps,
      contextLength: deps.getContextLength(automation.providerId, automation.model),
      maxTokens: deps.getMaxOutputTokens?.(automation.providerId, automation.model),
      messages,
      tools,
      permissions: automationPermissions(),
      // Unattended: never interactive. neverSkip-routed tools (computer-use) are
      // denied here instead of prompting. Browser access is governed by the
      // automation's consent in beforeTool, which runs for every call.
      resolvePermission: async (req: { toolName: string; args: Record<string, unknown> }) => {
        if (automationRequiresExtraConfirmation(req.toolName, req.args)) return "deny";
        return "allow";
      },
      cwd,
      thinking: deps.settings.get().thinking,
      signal,
      memory: withMemory && deps.settings.get().memoryEnabled ? (opts.bot?.memory ?? deps.memory) : undefined,
      toolContext: {
        // Keeps this automation's Chrome tabs apart from every other run's, and tells the host an unattended
        // caller from a person when Chrome asks about a new site.
        sessionMeta: { threadId: automationThreadId(automation.id), cwd, model: automation.model },
        memory: deps.settings.get().memoryEnabled ? (opts.bot?.memory ?? deps.memory) : undefined,
        // The skill tool resolves names against ctx.skills; the system prompt
        // alone is not enough for it to find anything mid-run.
        skills: env.skills.map((s) => ({ name: s.name, path: s.path, description: s.description })),
        onFileChanged: (change) => {
          emit({ type: "file-change", path: change.path, before: change.before, after: change.after });
        },
      },
      onMessage: (message) => store.append(meta.id, message),
      beforeTool: async (call, args, summary) => {
        // The run's own guard rails come before hooks: they hold whatever a workspace's hooks say.
        const guarded = guardToolCall(call.name, args, browserOrigins);
        if (guarded) return guarded;
        const pre = await runHooks(env.hooks, "preToolUse", call.name, { tool: call.name, args, summary, cwd });
        if (pre.blocked) return { block: pre.reason ?? "preToolUse hook" };
        if (call.name === "bash") {
          const command = typeof args.command === "string" ? args.command : "";
          const shellHook = await runHooks(env.hooks, "beforeShellExecution", command, { command, cwd });
          if (shellHook.blocked) return { block: shellHook.reason ?? "beforeShellExecution hook" };
        }
        // Last, after the run's own rails and hooks.
        if (parentGuard) return parentGuard(call, args, summary);
        return undefined;
      },
      afterTool: async (call, resultText, ok) => {
        await runHooks(env.hooks, "postToolUse", call.name, { tool: call.name, ok, resultChars: resultText.length, cwd });
      },
      onEvent: (event) => {
        opts.onActivity?.();
        switch (event.type) {
          case "step-start":
            steps += 1;
            break;
          case "text-delta":
            emit({ type: "text-delta", delta: event.delta });
            break;
          case "reasoning-delta":
            emit({ type: "reasoning-delta", delta: event.delta });
            break;
          case "tool-start":
            emit({ type: "tool-start", callId: event.call.id, name: event.call.name, summary: event.summary });
            break;
          case "tool-end":
            emit({
              type: "tool-end",
              callId: event.call.id,
              name: event.call.name,
              summary: "",
              result: event.result.length > 8_000 ? `${event.result.slice(0, 8_000)}\n… (truncated)` : event.result,
              ok: event.ok,
              denied: event.denied,
            });
            break;
          case "file-change":
            emit({ type: "file-change", path: event.change.path, before: event.change.before, after: event.change.after });
            break;
          case "todos":
            emit({ type: "todos", todos: event.todos });
            break;
          case "usage":
            emit({ type: "usage", totalTokens: event.usage.totalTokens });
            break;
          default:
            break;
        }
      },
    });

  try {
    const result = await turn(env.registry, limits.maxSteps, true);

    // A run that finished on its own without saying how it went gets one chance, with only
    // the report tool in reach, so the outcome is the run's word rather than a guess.
    if (result.reason === "completed" && !runTools.reported() && !signal?.aborted) {
      const reminder: AgentMessage = { role: "user", content: REPORT_REMINDER };
      messages.push(reminder);
      store.append(meta.id, reminder);
      await turn(env.registry.filtered(["automation_report"]), 3, false);
    }

    await runHooks(env.hooks, "stop", "stop", { reason: result.reason, cwd });
    emit({ type: "done", reason: result.reason, finalText: result.finalText });
    return { reason: result.reason, finalText: result.finalText, report: runTools.reported() };
  } finally {
    await closeMcp(env.mcpConnections);
  }
}
