/**
 * Readiness gates for delivery mode — block mutations and premature completion
 * until evidence requirements are satisfied.
 */

import type { TodoItem } from "../types.js";
import { EvidenceLedger } from "./ledger.js";

export interface GateResult {
  ok: boolean;
  code: string;
  message: string;
}

function fail(code: string, message: string): GateResult {
  return { ok: false, code, message };
}

function pass(): GateResult {
  return { ok: true, code: "ok", message: "" };
}

/** Active todos exclude cancelled entries. */
export function activeTodos(todos: TodoItem[]): TodoItem[] {
  return todos.filter((t) => t.status !== "cancelled");
}

/**
 * Mutations require a todo list with acceptance criteria on active steps.
 * At least one non-cancelled todo must define acceptanceCriteria before writes.
 */
export function checkMutationReadiness(todos: TodoItem[]): GateResult {
  const active = activeTodos(todos);
  if (active.length === 0) {
    return fail(
      "no_todos",
      "Delivery mode blocked this mutation: create todos with acceptance criteria via todo_write before editing files.",
    );
  }
  const withCriteria = active.filter((t) => typeof t.acceptanceCriteria === "string" && t.acceptanceCriteria.trim().length > 0);
  if (withCriteria.length === 0) {
    return fail(
      "no_acceptance_criteria",
      "Delivery mode blocked this mutation: each active todo needs acceptanceCriteria describing how to verify the step.",
    );
  }
  return pass();
}

/**
 * Finalization requires every active todo to be signed off via complete_step
 * with a recorded verification command.
 */
export function checkFinalizationReadiness(todos: TodoItem[], ledger: EvidenceLedger): GateResult {
  const active = activeTodos(todos);
  if (active.length === 0) {
    return fail(
      "no_todos",
      "Cannot finalize: delivery mode requires a todo list. Create steps with acceptance criteria first.",
    );
  }

  const unsigned = active.filter((t) => !ledger.hasSignOffForStep(t.id) && !t.signedOff);
  if (unsigned.length > 0) {
    const names = unsigned.map((t) => `"${t.content}" (${t.id})`).join(", ");
    return fail(
      "unsigned_steps",
      `Cannot finalize: call complete_step for each todo before finishing. Missing sign-off: ${names}.`,
    );
  }

  const unverified = ledger.unverifiedMutations();
  if (unverified.length > 0) {
    return fail(
      "unverified_mutations",
      `Cannot finalize: ${unverified.length} workspace mutation(s) lack a complete_step sign-off with verification.`,
    );
  }

  const incomplete = active.filter((t) => t.status !== "completed");
  if (incomplete.length > 0) {
    return fail(
      "incomplete_todos",
      `Cannot finalize: mark todos completed after complete_step. Still open: ${incomplete.map((t) => t.id).join(", ")}.`,
    );
  }

  return pass();
}

/** Detect assistant text that prematurely declares completion without evidence. */
export function blockPrematureCompletion(finalText: string, todos: TodoItem[], ledger: EvidenceLedger): GateResult {
  const trimmed = finalText.trim();
  if (!trimmed) return pass();

  const donePattern =
    /\b(all done|task complete|finished implementing|implementation complete|ready for review|work is done|that'?s everything|i'?ve completed)\b/i;
  if (!donePattern.test(trimmed)) return pass();

  return checkFinalizationReadiness(todos, ledger);
}
