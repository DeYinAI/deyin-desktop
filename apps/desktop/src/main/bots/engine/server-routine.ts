import type { AgentUiEvent, BotPermissionSettings, BotRuntime, BotSkillInput, DeyinBot, MemoryFact } from "@deyin/host-core";
import { runServerBotTurn } from "./server-chat.js";

export interface ServerRoutineRun {
  runtime: Pick<BotRuntime, "run">;
  /** The name of the server, for messages. */
  label: string;
  routineName: string;
  bot: DeyinBot;
  permissions: BotPermissionSettings;
  memory: readonly Pick<MemoryFact, "title" | "description" | "body">[];
  /** What the Bot has learned to do; written into the prompt, as for a chat. */
  skills?: readonly BotSkillInput[];
  /** The routine's model is served by the person's own endpoint. */
  customProvider: boolean;
  model: string;
  prompt: string;
  maxSteps: number;
  maxMinutes: number;
  emit: (event: AgentUiEvent) => void;
  signal: AbortSignal;
}

export interface ServerRoutineResult {
  reason: "completed" | "max-steps" | "aborted";
  finalText: string;
}

/**
 * One run of a routine, as the Bot, on its server, started from this app (by hand, or at a set time). The runs the
 * engine starts on a schedule do not come through here. A run that fails is thrown, so the app records it as failed
 * and may try again if nothing had been done yet; one that finishes ends with its `done`.
 */
export async function runServerRoutine(options: ServerRoutineRun): Promise<ServerRoutineResult> {
  const outcome: { failure: string | null; result: ServerRoutineResult } = { failure: null, result: { reason: "aborted", finalText: "" } };
  await runServerBotTurn(
    options.runtime,
    {
      bot: options.bot,
      permissions: options.permissions,
      memory: options.memory,
      ...(options.skills ? { skills: options.skills } : {}),
      history: [],
      prompt: options.prompt,
      model: options.model,
      customProvider: options.customProvider,
      imageCount: 0,
      maxSteps: options.maxSteps,
      timeoutMs: options.maxMinutes * 60_000,
      lead: `Your routine "${options.routineName.replace(/\s+/g, " ").trim().slice(0, 80)}" is running now. Nobody is chatting with you: do the task below, and finish with a short report of what you did.`,
    },
    (event) => {
      if (event.type === "error") outcome.failure = event.message;
      else if (event.type === "done") outcome.result = { reason: event.reason, finalText: event.finalText };
      else options.emit(event);
    },
    { label: options.label, signal: options.signal },
  );
  if (outcome.failure !== null) throw new Error(outcome.failure);
  options.emit({ type: "done", reason: outcome.result.reason, finalText: outcome.result.finalText });
  return outcome.result;
}
