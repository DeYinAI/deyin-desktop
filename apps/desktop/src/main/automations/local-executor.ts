import { SessionStore } from "@deyin/agent-core";
import { join } from "node:path";
import { app } from "electron";
import { runAgent, runHooks, runSubagent, subagentEffort } from "@deyin/agent-core";
import type { AgentMessage } from "@deyin/agent-core";
import type { Automation } from "@deyin/host-core";
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

export interface LocalRunOptions {
  automation: Automation;
  /** Payload already resolved to text (see payload.ts). */
  prompt: string;
  /** Set when the payload names a subagent: delegate in-process instead. */
  subagent?: SubagentDefinition;
  cwd: string;
  onEvent: (event: AgentUiEvent) => void;
  signal?: AbortSignal;
}

export interface LocalRunResult {
  reason: "completed" | "max-steps" | "aborted";
  finalText: string;
}

export async function runLocalAutomation(
  deps: AgentRunContextDeps,
  opts: LocalRunOptions,
): Promise<LocalRunResult> {
  const { automation, prompt, cwd, onEvent, signal } = opts;
  const env = await buildAutomationEnvironment(deps, cwd, automation.providerId);
  const system = await buildAutomationSystemPrompt(deps, cwd, env.registry);
  const messages: AgentMessage[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];

  // A subagent payload delegates directly rather than asking the model to call
  // the task tool — the automation registry has no task tool, and runSubagent
  // already gives the child a clean context and its own toolset.
  if (opts.subagent) {
    const settings = deps.settings.get();
    const def = opts.subagent;
    const result = await runSubagent(def, prompt, {
      cwd,
      parent: { model: automation.model, providerId: automation.providerId, thinking: settings.thinking },
      modelOverride: settings.subagentModels[def.name],
      effortOverride: subagentEffort(settings.subagentEfforts[def.name], def.effort),
      maxStepsDefault: settings.subagentMaxSteps,
      parentRouting: { apiBaseUrl: env.provider.apiBaseUrl, getToken: env.provider.getToken },
      permissionEngine: automationPermissions(),
      resolvePermission: async (req) => {
        if (automationRequiresExtraConfirmation(req.toolName, req.args)) return "deny";
        return "allow";
      },
      signal,
      onEvent: (event) => {
        if (event.type === "text-delta") onEvent({ type: "text-delta", delta: event.delta });
        else if (event.type === "tool-start") {
          onEvent({ type: "tool-start", callId: event.call.id, name: event.call.name, summary: event.summary });
        }
      },
    });
    await closeMcp(env.mcpConnections);
    if (!result.ok) onEvent({ type: "error", message: result.report });
    onEvent({ type: "done", reason: result.ok ? "completed" : "aborted", finalText: result.report });
    return { reason: result.ok ? "completed" : "aborted", finalText: result.report };
  }

  const store = new SessionStore(join(app.getPath("userData"), "automation-sessions"));
  const meta = store.create({ cwd, model: automation.model, agent: "automation" });
  for (const message of messages) store.append(meta.id, message);

  const emit = (event: AgentUiEvent): void => onEvent(event);

  try {
    const result = await runAgent({
      apiBaseUrl: env.provider.apiBaseUrl,
      getToken: env.provider.getToken,
      model: automation.model,
      contextLength: deps.getContextLength(automation.providerId, automation.model),
      messages,
      tools: env.registry,
      permissions: automationPermissions(),
      // Unattended: never interactive. neverSkip-routed tools (computer-use,
      // chrome navigation) are denied here instead of prompting.
      resolvePermission: async (req: { toolName: string; args: Record<string, unknown> }) => {
        if (req.toolName === "chrome_navigate") return "deny";
        if (automationRequiresExtraConfirmation(req.toolName, req.args)) return "deny";
        return "allow";
      },
      cwd,
      thinking: deps.settings.get().thinking,
      signal,
      memory: deps.settings.get().memoryEnabled ? deps.memory : undefined,
      toolContext: {
        memory: deps.settings.get().memoryEnabled ? deps.memory : undefined,
        // The skill tool resolves names against ctx.skills; the system prompt
        // alone is not enough for it to find anything mid-run.
        skills: env.skills.map((s) => ({ name: s.name, path: s.path, description: s.description })),
      },
      onMessage: (message) => store.append(meta.id, message),
      beforeTool: async (call, args, summary) => {
        const pre = await runHooks(env.hooks, "preToolUse", call.name, { tool: call.name, args, summary, cwd });
        if (pre.blocked) return { block: pre.reason ?? "preToolUse hook" };
        if (call.name === "bash") {
          const command = typeof args.command === "string" ? args.command : "";
          const shellHook = await runHooks(env.hooks, "beforeShellExecution", command, { command, cwd });
          if (shellHook.blocked) return { block: shellHook.reason ?? "beforeShellExecution hook" };
        }
        return undefined;
      },
      afterTool: async (call, resultText, ok) => {
        await runHooks(env.hooks, "postToolUse", call.name, { tool: call.name, ok, resultChars: resultText.length, cwd });
      },
      onEvent: (event) => {
        switch (event.type) {
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

    await runHooks(env.hooks, "stop", "stop", { reason: result.reason, cwd });
    emit({ type: "done", reason: result.reason, finalText: result.finalText });
    return { reason: result.reason, finalText: result.finalText };
  } finally {
    await closeMcp(env.mcpConnections);
  }
}
