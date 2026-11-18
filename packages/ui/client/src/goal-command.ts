import type { ThreadGoal } from "@deyin/contract";
import {
  applyGoalCommandText,
  describeGoal,
  goalFieldsFromCommand,
  GOAL_USAGE,
  isGoalCommand,
  matchGoalCommand,
  parseGoalCommand,
} from "@deyin/agent-core/goal-command";

export {
  applyGoalCommandText,
  describeGoal,
  GOAL_USAGE,
  isGoalCommand,
  matchGoalCommand,
  parseGoalCommand,
};

/** What a composer line asks of the goal, with the control words kept apart from objectives. */
export type GoalInputAction =
  | { kind: "not-goal" }
  | { kind: "set"; objective: string }
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "pause" }
  | { kind: "resume" };

/**
 * Classify a composer line. Unlike `applyGoalCommandText`, which collapses every
 * control word into "clear the goal", each form maps to its own action: a bare
 * `/goal` only reports status, and pause/resume act on the goal that exists.
 */
export function goalInputAction(text: string): GoalInputAction {
  const parsed = parseGoalCommand(text);
  return parsed ?? { kind: "not-goal" };
}

/** Thread patch for a parsed /goal result (null clears the goal). */
export function goalPatchFromCommand(
  goal: string | null,
  ids?: { id?: string; boot?: string; maxRounds?: number },
): { goal: ThreadGoal | undefined } {
  const fields = goalFieldsFromCommand(goal, ids);
  return { goal: fields as ThreadGoal | undefined };
}

/** Apply a control transition (`pause` / `resume`) to a live goal without losing its text. */
export function transitionGoal(goal: ThreadGoal, command: "pause" | "resume"): ThreadGoal {
  const now = new Date().toISOString();
  if (command === "pause") {
    return { ...goal, status: "paused", updatedAt: now, ...(goal.rounds !== undefined ? { rounds: goal.rounds } : {}) };
  }
  return {
    ...goal,
    status: "active",
    // A resume starts a fresh budget from this round, matching the target loop.
    rounds: 1,
    updatedAt: now,
  };
}

/** True when the goal still wants the loop to run. */
export function goalIsActive(goal: ThreadGoal | undefined): boolean {
  return goal?.status === "active";
}

/** Human label for the goal chip. */
export function goalChipLabel(goal: ThreadGoal | undefined): string {
  if (!goal) return "Set goal";
  if (goal.status === "active") {
    return goal.maxRounds !== undefined ? `Goal ${goal.rounds ?? 0}/${goal.maxRounds}` : "Goal";
  }
  if (goal.status === "paused") return "Goal paused";
  if (goal.status === "done" || goal.status === "met") return "Goal met";
  if (goal.status === "blocked") return "Goal blocked";
  if (goal.status === "exhausted") return "Goal out of rounds";
  return "Goal";
}

/** Menu description for `/goal`, depending on whether the thread already has one. */
export function goalCommandDescription(currentGoal: string | null | undefined): string {
  return currentGoal
    ? "Replace the current goal (/goal clear removes it)"
    : "Set a goal: the agent restates it, then works until it is met";
}

/**
 * One-line hint shown while the composer holds `/goal <objective>`: what pressing
 * Enter will do. Null for any other text, and for the control words, which
 * act on the existing goal rather than setting a new one.
 */
export function goalComposerHint(value: string, currentGoal: string | null | undefined): string | null {
  if (!/^\/goal\s/i.test(value)) return null;
  const parsed = parseGoalCommand(value);
  if (parsed && parsed.kind !== "set" && parsed.kind !== "status") return null;
  if (currentGoal) return `Current goal: ${currentGoal} Type a new objective to replace it.`;
  return "The agent restates this as a checkable objective, then starts working.";
}
