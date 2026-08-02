import { SessionStore } from "@deyin/agent-core";
import { join } from "node:path";
import { app } from "electron";
import { runAgent, runHooks } from "@deyin/agent-core";
import type { AgentMessage } from "@deyin/agent-core";
import type { Automation } from "@deyin/host-core";
import type { AgentUiEvent } from "../../shared/types.js";
import {
  automationPermissions,
  buildAutomationEnvironment,
  buildAutomationSystemPrompt,
  closeMcp,
  type AgentRunContextDeps,
} from "./agent-run-context.js";
import { requiresExtraConfirmation } from "../permission-policy.js";

export interface LocalRunOptions {
  automation: Automation;
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
  const { automation, cwd, onEvent, signal } = opts;
  const env = await buildAutomationEnvironment(deps, cwd, automation.providerId);
  const system = await buildAutomationSystemPrompt(deps, cwd, env.registry);
  const messages: AgentMessage[] = [
    { role: "system", content: system },
    { role: "user", content: automation.prompt },
  ];

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
      permissions: automationPermissions(env.hostRules),
      resolvePermission: async (req) => {
        if (req.toolName === "chrome_navigate") return "deny";
        if (requiresExtraConfirmation(req.toolName, req.args)) return "deny";
        return "allow";
      },
      forcePermissionPrompt: (req) => requiresExtraConfirmation(req.toolName, req.args),
      cwd,
      thinking: deps.settings.get().thinking,
      signal,
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
