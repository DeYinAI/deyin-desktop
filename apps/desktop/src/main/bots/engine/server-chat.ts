import {
  BotError,
  RUNTIME_LIMITS,
  buildBotPersona,
  runModeForApproval,
  serverRuleConflict,
  type AgentUiEvent,
  type BotPermissionSettings,
  type BotRuntime,
  type BotSkillInput,
  type DeyinBot,
  type MemoryFact,
  type RuntimeRunRequest,
  type RuntimeRunResult,
} from "@deyin/host-core";
import { parseCliLine } from "../../automations/cli-invocation.js";
import { buildServerPrompt, type ServerTurn } from "./server-prompt.js";

/** What the agent host needs to chat with a Bot that lives on a server. */
export interface ServerBotPort {
  /** The computer a Bot works on. Throws a `BotError` when it has no usable server. */
  runtime(bot: DeyinBot): BotRuntime;
  /** The name of the server a Bot lives on, for messages. */
  label(bot: DeyinBot): string;
}

export interface ServerTurnInput {
  bot: DeyinBot;
  /** The saved tool rules; a server cannot enforce them one by one, so some combinations are refused. */
  permissions: BotPermissionSettings;
  /** The Bot's active facts, read into the prompt because a server has no memory tools. */
  memory: readonly Pick<MemoryFact, "title" | "description" | "body">[];
  /** What the Bot has learned to do, written into the prompt for the same reason. */
  skills?: readonly BotSkillInput[];
  /** Turns before this one, oldest first; each server turn is stateless, so all of it is sent. */
  history: readonly ServerTurn[];
  /** What the person just said. */
  prompt: string;
  model: string;
  /** The chosen model is served by the person's own endpoint, which the server is not signed in to. */
  customProvider: boolean;
  /** Pictures attached to this message. */
  imageCount: number;
  /** The user's step-limit setting: a number, or null for none. */
  maxSteps?: number | null;
  /** Introduces the task in the prompt; a routine says nobody is chatting. */
  lead?: string;
  /** The longest the run may last on the server. */
  timeoutMs?: number;
}

const MAX_STEPS = 1_000;

/** Whether a run on a server can go ahead as asked, and if not why, in words for the person. Pure so the composer can say it before sending. */
export function serverTurnRefusal(input: Pick<ServerTurnInput, "bot" | "permissions" | "customProvider" | "imageCount" | "model">): string | null {
  if (input.customProvider) return "A Bot on a server can only use models served by Openference. Pick one from the model list, or move this Bot back to this computer.";
  if (input.imageCount > 0) return "Pictures cannot be sent to a Bot that runs on a server yet. Send the message without them, or move this Bot back to this computer.";
  if (!input.model.trim() || /\s/.test(input.model) || input.model.length > 200) return "Pick a model for this Bot before chatting.";
  return serverRuleConflict(input.permissions, input.bot.autoReview.approvalMode);
}

/**
 * The turns before this one. The conversation the app keeps may already hold what the person just said as its last
 * turn; sent as history and then again as the task it would be said twice, so it is dropped from the history.
 */
export function earlierTurns(history: readonly ServerTurn[], prompt: string): readonly ServerTurn[] {
  const last = history.at(-1);
  if (last && last.role === "user" && last.content.trim() !== "" && prompt.trim().startsWith(last.content.trim())) return history.slice(0, -1);
  return history;
}

/** What the engine is asked to run for one turn. Throws `BotError` when it cannot be run. */
export function buildServerRunRequest(input: ServerTurnInput): RuntimeRunRequest {
  const refusal = serverTurnRefusal(input);
  if (refusal) throw new BotError("invalid", refusal);
  const prompt = buildServerPrompt({
    persona: buildBotPersona(input.bot, { memoryTools: false }),
    memory: input.memory,
    ...(input.skills ? { skills: input.skills } : {}),
    history: earlierTurns(input.history, input.prompt),
    task: input.prompt,
    ...(input.lead ? { lead: input.lead } : {}),
  });
  const steps = typeof input.maxSteps === "number" && Number.isFinite(input.maxSteps) ? Math.min(MAX_STEPS, Math.max(1, Math.floor(input.maxSteps))) : undefined;
  return {
    prompt,
    model: input.model.trim(),
    mode: runModeForApproval(input.bot.autoReview.approvalMode),
    ...(steps !== undefined ? { maxSteps: steps } : {}),
    ...(typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? { timeoutMs: Math.min(Math.round(input.timeoutMs), RUNTIME_LIMITS.runTimeoutMaxMs) } : {}),
  };
}

/** The words a failed or cut-off run is reported in. */
export function describeServerEnd(result: RuntimeRunResult, label: string): string | null {
  switch (result.reason) {
    case "completed":
    case "max-steps":
    case "aborted":
      return null;
    case "timeout":
      return `The run on ${label} took too long and was stopped.`;
    case "failed":
      return result.error?.trim() || `The run on ${label} failed.`;
    default: {
      const unhandled: never = result.reason;
      throw new Error(`Unhandled run reason: ${String(unhandled)}`);
    }
  }
}

/**
 * One chat turn for a Bot that lives on a server: the engine runs the agent there and streams what it does,
 * which is shown as it would be for a local run. It ends the way every run ends, with one `done`; a run that
 * did not finish says why in an `error` first. Problems reaching the server are thrown, for the caller's own
 * error path, since nothing ran.
 */
export async function runServerBotTurn(
  runtime: Pick<BotRuntime, "run">,
  input: ServerTurnInput,
  send: (event: AgentUiEvent) => void,
  options: { label: string; signal?: AbortSignal },
): Promise<void> {
  const request = buildServerRunRequest(input);
  const result = await runtime.run(
    request,
    (line) => {
      const event = parseCliLine(line);
      // The CLI's own `done` is replaced by one built from how the run really ended.
      if (event && event.type !== "done" && event.type !== "error") send(event);
    },
    options.signal,
  );
  const problem = describeServerEnd(result, options.label);
  if (problem) send({ type: "error", message: problem });
  const reason: "completed" | "max-steps" | "aborted" =
    result.reason === "completed" ? "completed" : result.reason === "max-steps" ? "max-steps" : "aborted";
  send({ type: "done", reason, finalText: problem ? "" : result.finalText });
}
