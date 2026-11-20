import { EMPTY_PERMISSIONS, type Automation } from "@deyin/host-core";
import type { ResolvedPayload } from "../../automations/payload.js";
import type { RunContext } from "../../automations/runner.js";
import { requireBotRun, type BotRunSource } from "../run.js";
import type { ServerBotPort } from "./server-chat.js";
import { runServerRoutine, type ServerRoutineResult } from "./server-routine.js";

export interface ServerRoutineSource {
  bots: BotRunSource | undefined;
  servers: ServerBotPort | undefined;
  /** Whether a model provider is the person's own endpoint, which a server is not signed in to. */
  isCustomProvider(providerId: string): boolean;
  /** Whether Bots are told what they remember; the same setting chat and a local routine follow. */
  memoryEnabled(): boolean;
}

/**
 * A routine of a Bot that lives on a server runs there, whatever its own target says: the Bot's computer is its
 * server. Returns how the run ended, or null when the routine is not a server Bot's and the caller runs it itself.
 * A refusal (the Bot is gone, a subagent was asked for, servers are unavailable) is thrown so the run fails clearly.
 */
export async function runOnBotsServer(
  automation: Automation,
  resolved: Pick<ResolvedPayload, "prompt" | "subagent">,
  ctx: Pick<RunContext, "limits" | "emit" | "signal">,
  source: ServerRoutineSource,
): Promise<ServerRoutineResult | null> {
  if (automation.botId === undefined || !source.bots) return null;
  const botRun = requireBotRun(source.bots, automation.botId);
  if (botRun.bot.harness !== "server") return null;
  if (!source.servers) throw new Error("Servers are not available in this window.");
  if (resolved.subagent) throw new Error("A routine that hands work to a subagent runs only on this computer.");
  return runServerRoutine({
    runtime: source.servers.runtime(botRun.bot),
    label: source.servers.label(botRun.bot),
    routineName: automation.name,
    bot: botRun.bot,
    permissions: source.bots.permissions?.get() ?? EMPTY_PERMISSIONS,
    memory: source.memoryEnabled() ? botRun.memory.list() : [],
    skills: await botRun.skills.all(),
    customProvider: source.isCustomProvider(automation.providerId),
    model: automation.model,
    prompt: resolved.prompt,
    maxSteps: ctx.limits.maxSteps,
    maxMinutes: ctx.limits.maxMinutes,
    emit: ctx.emit,
    signal: ctx.signal,
  });
}
