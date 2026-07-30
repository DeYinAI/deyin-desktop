import type { InteractionRequest } from "./types.js";

const CANCELLED_KEY = "__cancelled";

/** Parse ask_question IPC/CLI response; surfaces explicit cancellation to the model. */
export function formatAskQuestionResponse(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed[CANCELLED_KEY] === "string") return parsed[CANCELLED_KEY];
    return raw;
  } catch {
    return raw;
  }
}

export const ASK_QUESTION_CANCELLED = "AskQuestion was cancelled before answers were returned.";

export function cancelledAskQuestionPayload(): Record<string, string> {
  return { [CANCELLED_KEY]: ASK_QUESTION_CANCELLED };
}

/** Headless/--yes fallback: pick the first option for every question. */
export function autoSelectAskQuestionAnswers(
  request: Extract<InteractionRequest, { type: "ask-question" }>,
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {};
  for (const q of request.questions) {
    const first = q.options[0];
    if (!first) continue;
    answers[q.id] = q.allow_multiple ? [first.id] : first.id;
  }
  return answers;
}
