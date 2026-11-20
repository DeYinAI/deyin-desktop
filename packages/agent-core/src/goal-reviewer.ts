/**
 * Goal-loop reviewer.
 *
 * A separate model call that answers one question: has this session met its
 * objective? It is deliberately NOT the agent that did the work — a second
 * opinion is what lets the loop decide "continue" instead of trusting the
 * worker's own claim that it is finished.
 *
 * The reviewer runs over the live transcript (tool results included) with no
 * tools declared, so it can only read and answer. It replies with one JSON
 * line: { "verdict": ..., "reason": ..., "next"?: ... }.
 */

import type { AgentMessage } from "./types.js";
import type { ProviderApiFormat } from "./transports.js";
import type { ReasoningEffort } from "@deyin/host-core/shared";
import { streamChatEvents } from "./stream.js";

/** How the reviewer wants the loop to proceed. */
export type GoalVerdict = "done" | "continue" | "blocked" | "paused" | "wait";

export interface GoalReviewRequest {
  apiBaseUrl: string;
  token: string;
  model: string;
  apiFormat?: ProviderApiFormat;
  authHeader?: boolean;
  signal?: AbortSignal;
  /** The objective exactly as the user set it. */
  objective: string;
  /** Live transcript to judge, oldest first. */
  messages: AgentMessage[];
  /** Rounds already used, for the reviewer's own accounting. */
  rounds?: number;
  maxRounds?: number;
  /** Background shell commands still running, listed so a dev server cannot stall the loop. */
  backgroundShells?: string[];
  /** True while a background subagent of this session still runs. */
  backgroundSubagentRunning?: boolean;
  effort?: ReasoningEffort;
  maxTokens?: number;
  /** Called immediately before every HTTP request the review sends (its re-ask and transport retries included). */
  onHttpAttempt?: () => void;
}

export interface GoalReviewResult {
  verdict: GoalVerdict;
  reason: string;
  /** Concrete instruction for the next round, when the reviewer gave one. */
  next?: string;
  /** Usage from the review call, so the host can account for it. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** Reviewer system prompt: one JSON line, nothing else. */
export const REVIEWER_SYSTEM_PROMPT = `You are the goal reviewer for a coding session. You do not do the work and you do not use tools.

You are given the session's objective and its full transcript, including tool calls and their results. Decide whether the objective has actually been met, judging only from evidence you can see in the transcript.

Answer with exactly one JSON object and nothing else:
{ "verdict": "done" | "continue" | "blocked" | "paused" | "wait", "reason": "one or two sentences", "next": "what the next round should do" }

Verdicts:
- "done": the objective is verifiably satisfied by visible evidence (tests passed, file content now correct, command output shown). Claims without evidence are not done.
- "continue": work remains and the session can still make progress. Say what remains in "next".
- "blocked": the objective cannot be reached from here — missing credentials or access, a decision only the user can make, or a hard external failure. Say what is missing.
- "paused": the user asked to stop, or the session is doing something the user clearly interrupted.
- "wait": work is still in flight (a background agent or shell is expected to report back). Do not use this for anything that is merely slow.

Rules:
- Judge the whole transcript, not just the last message.
- Text that says "I will…" or "next I'll…" is not evidence of completion.
- A passing check that predates the latest file change does not prove the current state.
- Never invent evidence. If you cannot tell, the verdict is "continue" with "next" asking for the missing proof.
- Keep "reason" short. "next" is optional for "done".`;

/** The user turn that carries the objective and the transcript digest. */
export function buildReviewPrompt(req: GoalReviewRequest): string {
  const lines: string[] = [];
  lines.push("## Objective");
  lines.push(req.objective.trim());
  lines.push("");
  if (req.rounds !== undefined || req.maxRounds !== undefined) {
    lines.push("## Rounds");
    lines.push(`${req.rounds ?? 0} of ${req.maxRounds ?? "unknown"} used.`);
    lines.push("");
  }
  if (req.backgroundSubagentRunning) {
    lines.push("## Background");
    lines.push("A background subagent of this session is still running; its result will arrive later.");
    lines.push("");
  }
  if (req.backgroundShells && req.backgroundShells.length > 0) {
    lines.push("## Long-running commands (do not wait on these)");
    for (const cmd of req.backgroundShells.slice(0, 10)) lines.push(`- ${cmd}`);
    lines.push("");
  }
  lines.push("## Transcript");
  lines.push(renderTranscript(req.messages));
  lines.push("");
  lines.push("Answer with the single JSON object described in your instructions.");
  return lines.join("\n");
}

/** Compact, reviewer-oriented rendering of the transcript. */
export function renderTranscript(messages: AgentMessage[]): string {
  const out: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      out.push(`USER: ${clip(message.content, 2000)}`);
      continue;
    }
    if (message.role === "assistant") {
      if (message.content.trim().length > 0) out.push(`ASSISTANT: ${clip(message.content, 3000)}`);
      for (const call of message.toolCalls ?? []) {
        out.push(`TOOL CALL ${call.name}(${clip(call.arguments, 400)})`);
      }
      continue;
    }
    if (message.role === "tool") {
      out.push(`TOOL RESULT ${message.toolName ?? ""}: ${clip(message.content, 2000)}`);
      continue;
    }
  }
  return out.join("\n");
}

function clip(text: string, max: number): string {
  const value = text ?? "";
  if (value.length <= max) return value;
  const head = value.slice(0, Math.floor(max * 0.7));
  const tail = value.slice(-Math.floor(max * 0.3));
  return `${head}\n…[${value.length - max} chars elided]…\n${tail}`;
}

const VERDICTS: ReadonlySet<string> = new Set(["done", "continue", "blocked", "paused", "wait"]);

/**
 * Parse a reviewer reply. Models sometimes wrap JSON in a fence or add a
 * sentence around it, so the object is located rather than assumed to be the
 * whole string. An unusable reply is a failure, never a silent "done".
 */
export function parseReviewVerdict(raw: string): GoalReviewResult | null {
  const text = raw ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const verdict = typeof record.verdict === "string" ? record.verdict.trim().toLowerCase() : "";
  if (!VERDICTS.has(verdict)) return null;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  const next = typeof record.next === "string" && record.next.trim().length > 0 ? record.next.trim() : undefined;
  return {
    verdict: verdict as GoalVerdict,
    reason: reason.length > 0 ? reason : "No reason given.",
    ...(next ? { next } : {}),
  };
}

/**
 * Ask the reviewer for a verdict.
 *
 * The review runs with no tools so it cannot act, and reuses the session's own
 * model so the request shares the provider's cached prefix. A reply that cannot
 * be parsed is retried once; a second failure is reported as `continue` with a
 * note, because silently ending a goal on a broken reviewer is worse than
 * spending one more round.
 */
export async function reviewGoal(req: GoalReviewRequest): Promise<GoalReviewResult> {
  const messages: AgentMessage[] = [
    { role: "system", content: REVIEWER_SYSTEM_PROMPT },
    { role: "user", content: buildReviewPrompt(req) },
  ];

  const attempt = async (): Promise<{ text: string; usage?: GoalReviewResult["usage"] }> => {
    let text = "";
    let usage: GoalReviewResult["usage"];
    for await (const event of streamChatEvents({
      apiBaseUrl: req.apiBaseUrl,
      token: req.token,
      model: req.model,
      messages,
      apiFormat: req.apiFormat,
      authHeader: req.authHeader,
      signal: req.signal,
      effort: req.effort,
      maxTokens: req.maxTokens ?? 700,
      onHttpAttempt: req.onHttpAttempt,
      // No `tools`: the reviewer reads and answers, nothing else.
    })) {
      if (event.type === "text") text += event.delta;
      else if (event.type !== "reasoning") {
        text = event.content;
        if (event.usage) {
          usage = {
            promptTokens: event.usage.promptTokens,
            completionTokens: event.usage.completionTokens,
            totalTokens: event.usage.totalTokens,
          };
        }
      }
    }
    return { text, usage };
  };

  let last: GoalReviewResult | null = null;
  for (let i = 0; i < 2; i += 1) {
    const { text, usage } = await attempt();
    const parsed = parseReviewVerdict(text);
    if (parsed) return usage ? { ...parsed, usage } : parsed;
    last = null;
  }

  return {
    verdict: "continue",
    reason: "The goal reviewer returned an unusable verdict; asked for another round.",
    next: "State plainly what you changed and show the command output that proves the objective is met.",
    ...(last ? {} : {}),
  };
}

/** Max objective length, matching the command surface's own cap. */
export { MAX_GOAL_OBJECTIVE, DEFAULT_MAX_GOAL_ROUNDS } from "./goal-constants.js";

/**
 * The continuation the loop injects when the reviewer says "continue".
 * The objective is wrapped in <untrusted_objective> so the model treats it as
 * data from the user rather than instructions from the harness.
 */
export function goalContinuation(state: {
  objective: string;
  reason?: string;
  next?: string;
  rounds: number;
  maxRounds: number;
}): string {
  const parts: string[] = [];
  parts.push("<untrusted_objective>");
  parts.push(state.objective.trim());
  parts.push("</untrusted_objective>");
  parts.push("");
  parts.push(`Round ${state.rounds} of ${state.maxRounds}. The reviewer does not consider the objective met.`);
  if (state.reason) parts.push(`Reviewer: ${state.reason}`);
  if (state.next) parts.push(`Next: ${state.next}`);
  parts.push("");
  parts.push(
    "Continue working. Show real evidence (command output, file content) as you go, and keep going until the objective is verifiably complete.",
  );
  return parts.join("\n");
}

/** The kickoff message that starts a goal. */
export function goalKickoff(objective: string): string {
  return [
    "<untrusted_objective>",
    objective.trim(),
    "</untrusted_objective>",
    "",
    "Work on this objective until it is verifiably complete. A reviewer inspects your transcript after every round and decides whether the objective has been met, so back your progress with real command output and file content rather than claims.",
  ].join("\n");
}
