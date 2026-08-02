import type { ToolDefinition } from "../types.js";
import { askQuestionTool } from "./ask-question.js";
import { awaitTaskTool } from "./await-task.js";
import { bashTool } from "./bash.js";
import { createPlanTool } from "./create-plan.js";
import { deleteTool } from "./delete.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { enterPlanModeTool, exitPlanModeTool, switchModeTool } from "./mode-tools.js";
import { notebookEditTool } from "./notebook-edit.js";
import { readTool } from "./read.js";
import { readSessionContextTool } from "./read-session-context.js";
import { sendMessageTool } from "./send-message.js";
import { skillTool } from "./skill.js";
import { todoReadTool } from "./todo-read.js";
import { ToolRegistry } from "./registry.js";
import { todoTool } from "./todo.js";
import { webFetchTool } from "./web-fetch.js";
import { websearchTool } from "./websearch.js";
import { writeTool } from "./write.js";
import { reportGoalMetTool } from "./report-goal-met.js";
import { completeStepTool } from "./complete-step.js";
import { enterWorktreeTool, exitWorktreeTool } from "./worktree.js";

export { ToolRegistry } from "./registry.js";
export { bashTool, effectiveShell } from "./bash.js";
export { readTool } from "./read.js";
export { writeTool } from "./write.js";
export { editTool, applyEdit, countOccurrences } from "./edit.js";
export { grepTool } from "./grep.js";
export { globTool } from "./glob.js";
export { lsTool } from "./ls.js";
export { websearchTool } from "./websearch.js";
export { webFetchTool } from "./web-fetch.js";
export { todoTool, renderTodos } from "./todo.js";
export { todoReadTool } from "./todo-read.js";
export { askQuestionTool } from "./ask-question.js";
export { createPlanTool } from "./create-plan.js";
export { enterPlanModeTool, exitPlanModeTool, switchModeTool } from "./mode-tools.js";
export { skillTool } from "./skill.js";
export { readSessionContextTool } from "./read-session-context.js";
export { sendMessageTool } from "./send-message.js";
export { deleteTool } from "./delete.js";
export { awaitTaskTool } from "./await-task.js";
export { enterWorktreeTool, exitWorktreeTool } from "./worktree.js";
export { notebookEditTool } from "./notebook-edit.js";
export { globToRegExp, matchGlob } from "./globmatch.js";
export {
  createTaskTool,
  TASK_SUBAGENT_CATALOG_MARKER,
  type TaskToolOptions,
  type TaskRunResult,
} from "./task.js";
export { createFleetTool, type FleetToolOptions } from "./fleet.js";
export { createParallelTasksTool, type ParallelTasksToolOptions } from "./parallel-tasks.js";
export { createWaitJobsTool } from "./wait-jobs.js";
export { createUseCapabilityTool, type UseCapabilityOptions } from "./use-capability.js";
export { createCodebaseSearchTool, type CodebaseSearchHit } from "./codebase-search.js";
export { reportGoalMetTool } from "./report-goal-met.js";
export { completeStepTool } from "./complete-step.js";
export {
  commitFileMutation,
  applyFileMutationDirect,
  readFileForMutation,
} from "./file-mutation.js";
export type { FileMutationRequest, FileMutationOp } from "./file-mutation.js";

export const BUILTIN_TOOLS: ToolDefinition[] = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  deleteTool,
  grepTool,
  globTool,
  lsTool,
  websearchTool,
  webFetchTool,
  todoTool,
  todoReadTool,
  askQuestionTool,
  createPlanTool,
  enterPlanModeTool,
  exitPlanModeTool,
  switchModeTool,
  skillTool,
  readSessionContextTool,
  sendMessageTool,
  awaitTaskTool,
  enterWorktreeTool,
  exitWorktreeTool,
  notebookEditTool,
  reportGoalMetTool,
  completeStepTool,
];

export function createBuiltinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);
  return registry;
}
