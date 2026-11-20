import { existsSync } from "node:fs";
import { Notification } from "electron";
import { type Automation, type AutomationBlocker, type AutomationRun, type AutomationStateStore, type SshHostsStore } from "@deyin/host-core";
import type { AuthManager } from "../auth.js";
import { requireBotRun, type BotRunSource } from "../bots/run.js";
import type { ServerBotPort } from "../bots/engine/server-chat.js";
import { runOnBotsServer } from "../bots/engine/routine-run.js";
import { buildAutomationEnvironment, closeMcp, credentialProbe, type AgentRunContextDeps } from "./agent-run-context.js";
import { browserReadiness, consentOrigins } from "./consent.js";
import { checkRequiredTools, preflight } from "./health.js";
import { runLocalAutomation } from "./local-executor.js";
import { runRemoteAutomation } from "./remote-executor.js";
import type { RunExecutor } from "./runner.js";
import { runWslAutomation } from "./wsl-executor.js";
import { sleep, systemClock } from "./watchdog.js";

/**
 * The runner's Electron-bound edges: the executors that actually start an
 * agent, and the desktop notification. Kept out of runner.ts so the runner's
 * own logic — limits, outcomes, health — can be tested without Electron.
 */

export function createRunExecutor(
  deps: AgentRunContextDeps,
  sshHosts: SshHostsStore,
  states: AutomationStateStore,
  bots?: BotRunSource,
  servers?: ServerBotPort,
): RunExecutor {
  return async (automation, resolved, token, ctx) => {
    const { target } = automation;
    const onServer = await runOnBotsServer(automation, resolved, ctx, {
      bots,
      servers,
      isCustomProvider: (providerId) => deps.agents.listProviders(true).find((p) => p.id === providerId)?.kind === "custom",
      memoryEnabled: () => deps.settings.get().memoryEnabled,
    });
    if (onServer) return onServer;
    switch (target.kind) {
      case "local": {
        // A Bot's routine works in the Bot's own folder, as the Bot; looked up now, so a deleted or archived Bot fails the run clearly.
        const bot = automation.botId !== undefined ? requireBotRun(bots, automation.botId) : undefined;
        return runLocalAutomation(deps, {
          automation,
          prompt: resolved.prompt,
          subagent: resolved.subagent,
          cwd: bot?.cwd ?? target.workspacePath,
          limits: ctx.limits,
          startedAt: ctx.startedAt,
          onEvent: ctx.emit,
          onActivity: ctx.touch,
          state: { get: () => states.get(automation.id), set: (value) => states.set(automation.id, value) },
          ...(bot ? { bot, botSource: bots } : {}),
          signal: ctx.signal,
        });
      }
      case "wsl":
        return runWslAutomation({
          automation,
          prompt: resolved.prompt,
          distro: target.distro,
          workspacePath: target.workspacePath,
          token,
          onEvent: ctx.emit,
          signal: ctx.signal,
        });
      case "ssh": {
        if (!sshHosts.get(target.hostId)) throw new Error("SSH host not found.");
        return runRemoteAutomation({
          automation,
          prompt: resolved.prompt,
          hosts: sshHosts,
          hostId: target.hostId,
          workspacePath: target.workspacePath,
          token,
          onEvent: ctx.emit,
          signal: ctx.signal,
        });
      }
      default: {
        const unreachable: never = target;
        throw new Error(`Unhandled automation target: ${JSON.stringify(unreachable)}`);
      }
    }
  };
}

export function notifyRunFinished(automation: Automation, run: AutomationRun): void {
  if (!Notification.isSupported()) return;
  const ok = run.status === "completed";
  const title = ok
    ? `Automation completed: ${automation.name}`
    : run.outcome === "blocked"
      ? `Automation blocked: ${automation.name}`
      : `Automation failed: ${automation.name}`;
  new Notification({
    title,
    body: ok ? (run.finalText?.slice(0, 120) || "Done.") : (run.blocker?.detail ?? run.reason ?? "Run failed."),
  }).show();
}

/**
 * The check a paused automation is put through before it is resumed: signed in, workspace present,
 * required tools available. No model is called. Returns what is still wrong, or null when it could run.
 */
export function createProbe(deps: AgentRunContextDeps, auth: AuthManager): (automation: Automation) => Promise<AutomationBlocker | null> {
  return async (automation) => {
    const pre = await preflight(automation, {
      ...credentialProbe({ agents: deps.agents, auth }, automation),
      workspaceExists: existsSync,
      sleep: (ms) => sleep(systemClock, ms),
      browser: () => browserReadiness(deps.chrome),
    });
    if (!pre.ok) return pre.blocker;
    const { target } = automation;
    if (target.kind !== "local" || !automation.requires?.tools?.length) return null;
    const env = await buildAutomationEnvironment(deps, target.workspacePath, automation.providerId, { browserOrigins: consentOrigins(automation) });
    try {
      return checkRequiredTools(automation.requires, env.registry.names());
    } finally {
      await closeMcp(env.mcpConnections);
    }
  };
}

/** Tells the user an automation was paused or resumed on its own. */
export function notifyHealth(automation: Automation, message: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title: automation.name, body: message }).show();
}
