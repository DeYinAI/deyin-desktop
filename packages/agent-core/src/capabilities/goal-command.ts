/**
 * The `/goal` command surface.
 *
 * `/goal <objective>` arms a goal on the thread. Once armed, the loop keeps the
 * session working — round after round — until the reviewer returns a verdict
 * that ends it. The control words pause, resume and clear are resolved here so
 * both the desktop composer and the CLI share one parser.
 */

import { MAX_GOAL_OBJECTIVE } from "../goal-constants.js";

/** What the user asked for. */
export type GoalCommand =
  | { kind: "set"; objective: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "status" };

const CONTROL_WORDS = new Set(["pause", "resume", "clear"]);

/** Strip one layer of matching quotes from the objective. */
function unquote(text: string): string {
  const value = text.trim();
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'" || first === "`" || first === "“") && (last === '"' || last === "'" || last === "`" || last === "”")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Parse `/goal …`. Returns null when the text is not a goal command.
 *
 *   /goal               -> status
 *   /goal " "           -> status (an objective of nothing is not one)
 *   /goal pause         -> pause
 *   /goal resume        -> resume
 *   /goal clear         -> clear
 *   /goal <objective>   -> set
 */
export function parseGoalCommand(raw: string): GoalCommand | null {
  const trimmed = (raw ?? "").trim();
  if (!/^\/goal(?:\s|$)/i.test(trimmed)) return null;

  const rest = trimmed.replace(/^\/goal/i, "").trim();
  if (rest.length === 0) return { kind: "status" };

  const control = rest.toLowerCase();
  if (CONTROL_WORDS.has(control)) return { kind: control as "pause" | "resume" | "clear" };

  const objective = unquote(rest);
  if (objective.length === 0) return { kind: "status" };
  return { kind: "set", objective: objective.slice(0, MAX_GOAL_OBJECTIVE) };
}

/** True when the text is any /goal invocation. */
export function isGoalCommand(text: string): boolean {
  return parseGoalCommand(text) !== null;
}

/** The objective text of a `/goal <objective>` invocation, or null. */
export function matchGoalCommand(raw: string): string | null | undefined {
  const parsed = parseGoalCommand(raw);
  if (!parsed) return undefined;
  if (parsed.kind === "set") return parsed.objective;
  return null;
}

/** Apply a `/goal` invocation. Returns whether the text was a goal command. */
export function applyGoalCommandText(text: string, apply: (goal: string | null) => void): boolean {
  const parsed = parseGoalCommand(text);
  if (!parsed) return false;
  if (parsed.kind === "set") {
    apply(parsed.objective);
    return true;
  }
  if (parsed.kind === "clear" || parsed.kind === "status") {
    apply(null);
    return true;
  }
  // pause / resume are state transitions, not objective edits; the host applies
  // them against the live goal so the objective text is never lost.
  apply(null);
  return true;
}

/** Goal fields for a fresh `/goal <objective>` (a new instance, zero rounds spent). */
export function goalFieldsFromCommand(
  goal: string | null,
  ids?: { id?: string; boot?: string; maxRounds?: number },
): { text: string; status: "active"; setAt: string; id?: string; rounds: number; maxRounds?: number; boot?: string; updatedAt: string } | undefined {
  if (goal === null) return undefined;
  const now = new Date().toISOString();
  return {
    text: goal,
    status: "active",
    setAt: now,
    updatedAt: now,
    rounds: 0,
    ...(ids?.id ? { id: ids.id } : {}),
    ...(ids?.boot ? { boot: ids.boot } : {}),
    ...(ids?.maxRounds !== undefined ? { maxRounds: ids.maxRounds } : {}),
  };
}

/** Thread patch for a parsed /goal result (null clears the goal). */
export function goalPatchFromCommand(
  goal: string | null,
  ids?: { id?: string; boot?: string; maxRounds?: number },
): { goal: ReturnType<typeof goalFieldsFromCommand> } {
  return { goal: goalFieldsFromCommand(goal, ids) };
}

/** One-line status summary, used by the bare `/goal` command. */
export function describeGoal(goal: {
  text: string;
  status: string;
  rounds?: number;
  maxRounds?: number;
  reason?: string;
} | undefined): string {
  if (!goal) return "No goal is set. Use /goal <objective> to set one.";
  const rounds = goal.maxRounds !== undefined ? `${goal.rounds ?? 0}/${goal.maxRounds} rounds` : `${goal.rounds ?? 0} rounds`;
  const lines = [`Goal (${goal.status}, ${rounds}): ${goal.text}`];
  if (goal.reason) lines.push(`Last reviewer note: ${goal.reason}`);
  return lines.join("\n");
}

export const GOAL_USAGE =
  "Usage: /goal <objective> · /goal pause · /goal resume · /goal clear · /goal (status)";
