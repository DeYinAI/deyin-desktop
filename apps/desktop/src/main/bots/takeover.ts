import type { InteractionRequest } from "@deyin/agent-core";

/**
 * "Take over": the Bot hands the browser to a person (a captcha, a code sent to their phone, a page it cannot
 * work out) and carries on when they say they are done. It is asked as a one-question card, so it needs no card
 * of its own.
 */

const QUESTION_ID = "takeover";

export function takeoverRequest(reason: string): Extract<InteractionRequest, { type: "ask-question" }> {
  return {
    type: "ask-question",
    title: "Take over the browser",
    questions: [
      {
        id: QUESTION_ID,
        prompt: reason,
        options: [
          { id: "done", label: "I'm done, carry on", description: "Do what the Bot needs in the browser first, then choose this.", recommended: true },
          { id: "declined", label: "I can't do this" },
        ],
      },
    ],
  };
}

/** How the person answered the card's reply (the JSON the card sends back); anything but a plain "done" is a no. */
export function takeoverOutcome(reply: string): "done" | "declined" {
  try {
    const parsed: unknown = JSON.parse(reply);
    if (typeof parsed !== "object" || parsed === null) return "declined";
    return (parsed as Record<string, unknown>)[QUESTION_ID] === "done" ? "done" : "declined";
  } catch {
    // A cancelled or timed-out card answers with plain text.
    return "declined";
  }
}
