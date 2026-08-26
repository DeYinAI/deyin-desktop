import type { ThreadGoal } from "@deyin/contract";
import {
  applyGoalCommandText,
  goalFieldsFromCommand,
  isGoalCommand,
  matchGoalCommand,
} from "@deyin/agent-core";

export { applyGoalCommandText, isGoalCommand, matchGoalCommand };

/** Thread patch for a parsed /goal result (null clears the goal). */
export function goalPatchFromCommand(goal: string | null): { goal: ThreadGoal | undefined } {
  const fields = goalFieldsFromCommand(goal);
  return { goal: fields as ThreadGoal | undefined };
}
