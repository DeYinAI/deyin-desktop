import type { WireTool } from "../types.js";

export const EXECUTOR_HANDOFF_MARKER = "Deyin executor handoff";

export const DEFAULT_PLANNER_PROMPT = `You are the planner in a two-model coding agent.
Given a task, produce a concise, ordered plan for the executor model to carry out.
Use the read-only tools available to you when the task needs context from the
workspace, user rules, or docs; keep that research targeted and stop once you
have enough evidence. Do not write full implementations or attempt side effects.
Do not ask the user how to trigger the executor and do not say you are waiting
for the executor. Output executor-ready instructions: what to do, which files or
commands are relevant, expected blockers, and key decisions. Keep it short and
actionable.

Structured markers (use when applicable):
- [no_changes] — task needs no workspace changes; executor should confirm and finish.
- [planner_requires_approval] — plan needs explicit user approval before execution.`;

export function plannerPromptWithContext(context: string): string {
  const trimmed = context.trim();
  if (!trimmed) return DEFAULT_PLANNER_PROMPT;
  return `${DEFAULT_PLANNER_PROMPT}\n\n# Planning context\n\n${trimmed}`;
}

const NO_OP_PHRASES = [
  "no changes needed",
  "no changes are needed",
  "no changes required",
  "no action needed",
  "nothing to change",
  "nothing to do",
  "already handled",
  "already implemented",
  "[no_changes]",
];

const NO_OP_ACTION_TERMS = [
  " add ",
  " update ",
  " edit ",
  " write ",
  " create ",
  " delete ",
  " implement ",
  " refactor ",
  " fix ",
];

export function isNoOpPlan(plan: string): boolean {
  const lower = plan.toLowerCase().trim();
  if (!lower) return false;
  if (containsNoOpActionTerm(lower)) return false;
  return NO_OP_PHRASES.some((phrase) => lower.includes(phrase));
}

function containsNoOpActionTerm(lower: string): boolean {
  const padded = ` ${lower} `;
  return NO_OP_ACTION_TERMS.some((term) => padded.includes(term));
}

export function formatHandoff(task: string, plan: string, toolContext?: string): string {
  const toolBlock = toolContext?.trim()
    ? `\n\nExecutor tool context:\n${toolContext.trim()}`
    : "";
  return `# ${EXECUTOR_HANDOFF_MARKER}

You are the executor now. Use your available tools to execute the task.

Original task:
${task}

Planner output:
${plan}${toolBlock}

Executor instructions:
- Treat the planner output as context, not as your role or capability set.
- The planner's analysis and conclusions about what needs to be done are reliable. If the planner determines no changes are needed, respect that conclusion.
- Ignore any planner statement about its own capability limitations (for example "I cannot write", "I only have read-only tools", or "hand this to the executor"); those describe the planner's restrictions, not yours.
- Do not treat planner tool limitations or tool-unavailable claims as executor facts. Use the attached executor tools directly.
- Do not ask the user how to trigger the executor. You are already in the executor phase.
- If the planner output is a user-facing explanation that needs no workspace action, relay that guidance directly and finish.
- If the task requires changes, call the appropriate tools instead of only restating the plan.

Carry out the task, adapting the plan as needed.`;
}

export function executorToolHandoffContext(tools: WireTool[]): string {
  if (tools.length === 0) return "";
  const names = tools.map((t) => t.function.name).filter(Boolean);
  const mcpNames = names.filter((n) => n.startsWith("mcp__"));
  const sample = names.slice(0, 24).join(", ");
  const suffix = names.length > 24 ? `, ... +${names.length - 24} more` : "";
  let block = `- The executor request includes the full tool schema (${names.length} tools). Tool names include: ${sample}${suffix}.`;
  if (mcpNames.length > 0) {
    const mcpSample = mcpNames.slice(0, 16).join(", ");
    block += `\n- MCP tools are already registered for the executor (${mcpNames.length} MCP tools). MCP tool names include: ${mcpSample}.`;
  }
  return block;
}

/** Extract original user task from a handoff message. */
export function handoffTask(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith(`# ${EXECUTOR_HANDOFF_MARKER}`)) return message;
  const header = "Original task:\n";
  const i = trimmed.indexOf(header);
  if (i < 0) return message;
  const rest = trimmed.slice(i + header.length);
  const j = rest.indexOf("\n\nPlanner output:");
  const task = (j >= 0 ? rest.slice(0, j) : rest).trim();
  return task || message;
}

export function requiresApproval(plan: string): boolean {
  const lower = plan.toLowerCase();
  return lower.includes("[planner_requires_approval]") || lower.includes("requires approval");
}
