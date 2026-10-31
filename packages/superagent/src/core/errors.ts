/** A refusal a person or an agent can cause: reported to the caller, never a bug. */
export class UserError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? USER_ERRORS[code] ?? code);
    this.name = "UserError";
    this.code = code;
  }
}

export const USER_ERRORS: Readonly<Record<string, string>> = {
  unknownTrigger: "Unknown trigger",
  unknownTicket: "Unknown ticket",
  unknownThread: "Unknown thread",
  noAssessment: "No assessment is in progress for this trigger; it was already decided, timed out, or never reached assessment",
  ticketEnded: "The ticket has ended",
  notReached: "This message did not reach the ticket",
  workerDecides: "A ticket's worker decides this person's follow-up; only a stop is allowed here",
  notExplicit: "Only an explicit request from an allowed sender can be routed this way; an inferred candidate goes through orchestrator_eval_decide",
  stopNotExplicit: "Only a person's explicit message stops a ticket",
  replyRefused: "The reply is not allowed",
  paused: "Processing is paused",
  conflict: "Settings changed since they were read; reload and try again",
  invalid: "Invalid value",
  setup: "Superagent is not set up",
};
