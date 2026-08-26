/** Parse the /goal command. Returns the goal text, null for "/goal" with no
 *  text (clear the goal), or undefined when the input is not a /goal command. */
export function matchGoalCommand(raw: string): string | null | undefined {
  const m = /^\/goal(?:\s+([\s\S]+))?\s*$/i.exec(raw.trim());
  if (!m) return undefined;
  const text = m[1]?.trim();
  return text && text.length > 0 ? text : null;
}

/** True when the composer text is a /goal invocation. */
export function isGoalCommand(text: string): boolean {
  return matchGoalCommand(text) !== undefined;
}

/** Apply a parsed /goal command via callback; returns whether the text was /goal. */
export function applyGoalCommandText(text: string, apply: (goal: string | null) => void): boolean {
  const goal = matchGoalCommand(text);
  if (goal === undefined) return false;
  apply(goal);
  return true;
}

/** Thread goal fields shared by UI transports (status always active on set). */
export function goalFieldsFromCommand(goal: string | null): { text: string; status: "active"; setAt: string } | undefined {
  if (goal === null) return undefined;
  return { text: goal, status: "active", setAt: new Date().toISOString() };
}

/** Thread patch for a parsed /goal result (null clears the goal). */
export function goalPatchFromCommand(goal: string | null): { goal: { text: string; status: "active"; setAt: string } | undefined } {
  return { goal: goalFieldsFromCommand(goal) };
}
