/**
 * Goal objective rewriter.
 *
 * `/goal <text>` is usually typed in a hurry ("make the build green"). Before the
 * first round starts, one tool-less model call restates it as an objective a
 * reviewer can check: every explicit deliverable, and the evidence that proves it.
 * The user's meaning, scope and language are kept — the rewrite never adds
 * requirements.
 *
 * Like `reviewGoal`, this is a separate call with no tools declared. It is also
 * strictly best-effort: any failure (error, timeout, empty or refused output) falls
 * back to the text the user typed, so setting a goal can never be blocked by it.
 */

import type { AgentMessage } from "./types.js";
import type { ProviderApiFormat } from "./transports.js";
import type { ReasoningEffort } from "@deyin/host-core/shared";
import { streamChatEvents } from "./stream.js";
import { MAX_GOAL_OBJECTIVE } from "./goal-constants.js";

/** Upper bound for the rewrite call; the first round waits on it. */
export const GOAL_REWRITE_TIMEOUT_MS = 15_000;

export interface GoalRewriteRequest {
  apiBaseUrl: string;
  token: string;
  model: string;
  apiFormat?: ProviderApiFormat;
  authHeader?: boolean;
  /** Caller's abort signal (the run being stopped). */
  signal?: AbortSignal;
  /** What the user typed after `/goal`. */
  objective: string;
  effort?: ReasoningEffort;
  maxTokens?: number;
  /** Override for tests; defaults to {@link GOAL_REWRITE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface GoalRewriteResult {
  /** The objective to run with: the restatement, or the typed text on fallback. */
  objective: string;
  /** True when `objective` is the model's restatement rather than the typed text. */
  rewritten: boolean;
  /** Why the typed text was kept, when it was. */
  fallbackReason?: "empty" | "too-long" | "refused" | "error" | "timeout" | "aborted";
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** System prompt: output the objective text and nothing else. */
export const REWRITER_SYSTEM_PROMPT = `You restate a user's goal as a clear, checkable objective for a coding agent. You do not do the work and you do not use tools.

You are given the objective exactly as the user typed it. Rewrite it so that someone reading only your text knows what "finished" means.

Rules:
- Keep the user's meaning, scope, names, paths, numbers and language. Do not add requirements, features or constraints they did not ask for.
- State every explicit deliverable the user asked for.
- State the evidence that would prove each deliverable is done (a command that passes, file content that is now correct, output that can be shown). Only name checks that follow naturally from the request; if you cannot tell which command applies, describe the evidence generically ("the project's tests pass and the output is shown").
- If the objective is already specific and checkable, change as little as possible.
- Be concise: one short paragraph, or a few short lines. No headings, no preamble, no quotes, no markdown fences.
- Output only the objective text. Never answer questions, never explain, never refuse.`;

/** The user turn: the typed objective, fenced so it is treated as data. */
export function buildRewritePrompt(objective: string): string {
  return [
    "<typed_objective>",
    objective.trim(),
    "</typed_objective>",
    "",
    "Restate this objective now. Output only the objective text.",
  ].join("\n");
}

const REFUSAL_PREFIXES = [
  "i can't",
  "i cannot",
  "i can not",
  "i'm sorry",
  "i am sorry",
  "sorry,",
  "i'm unable",
  "i am unable",
  "i won't",
  "as an ai",
];

/**
 * Turn a raw model reply into an objective, or null when it should not be used.
 *
 * Models wrap replies in fences, prefix a label ("Objective:") or quote the text;
 * those are stripped. Empty, oversized or refused replies yield null with a reason.
 */
export function parseRewrittenObjective(
  raw: string,
): { objective: string } | { fallbackReason: "empty" | "too-long" | "refused" } {
  let text = (raw ?? "").trim();
  // A reply that is one fenced block: take the inside.
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = (fenced[1] ?? "").trim();
  text = text.replace(/^(?:revised |restated |rewritten )?objective\s*:\s*/i, "").trim();
  // Surrounding quotes that wrap the whole reply.
  const quoted = /^(["'`“”])([\s\S]*)(["'`“”])$/.exec(text);
  if (quoted && !(quoted[2] ?? "").includes(quoted[1] ?? "\u0000")) text = (quoted[2] ?? "").trim();
  if (text.length === 0) return { fallbackReason: "empty" };
  if (text.length > MAX_GOAL_OBJECTIVE) return { fallbackReason: "too-long" };
  const lower = text.toLowerCase();
  if (REFUSAL_PREFIXES.some((prefix) => lower.startsWith(prefix))) return { fallbackReason: "refused" };
  return { objective: text };
}

/**
 * Restate `req.objective`. Never throws: a failed or unusable rewrite resolves to the
 * typed text with `rewritten: false`.
 */
export async function rewriteGoalObjective(req: GoalRewriteRequest): Promise<GoalRewriteResult> {
  const typed = req.objective.trim();
  const keepTyped = (fallbackReason: NonNullable<GoalRewriteResult["fallbackReason"]>): GoalRewriteResult => ({
    objective: typed,
    rewritten: false,
    fallbackReason,
  });
  if (typed.length === 0) return keepTyped("empty");
  if (req.signal?.aborted) return keepTyped("aborted");

  const timeout = AbortSignal.timeout(req.timeoutMs ?? GOAL_REWRITE_TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const messages: AgentMessage[] = [
    { role: "system", content: REWRITER_SYSTEM_PROMPT },
    { role: "user", content: buildRewritePrompt(typed) },
  ];

  let text = "";
  let usage: GoalRewriteResult["usage"];
  try {
    for await (const event of streamChatEvents({
      apiBaseUrl: req.apiBaseUrl,
      token: req.token,
      model: req.model,
      messages,
      apiFormat: req.apiFormat,
      authHeader: req.authHeader,
      signal,
      effort: req.effort,
      maxTokens: req.maxTokens ?? 900,
      // No `tools`: the rewriter reads and answers, nothing else.
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
  } catch {
    if (req.signal?.aborted) return keepTyped("aborted");
    return keepTyped(timeout.aborted ? "timeout" : "error");
  }

  const parsed = parseRewrittenObjective(text);
  if ("fallbackReason" in parsed) return { ...keepTyped(parsed.fallbackReason), ...(usage ? { usage } : {}) };
  return {
    objective: parsed.objective,
    rewritten: parsed.objective !== typed,
    ...(usage ? { usage } : {}),
  };
}
