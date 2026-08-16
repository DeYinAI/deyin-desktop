import type { ToolDefinition } from "../types.js";
import { askQuestionTool } from "./ask-question.js";
import { awaitTaskTool } from "./await-task.js";
import { reportGoalMetTool } from "./report-goal-met.js";
import { bashTool } from "./bash.js";
import { createPlanTool } from "./create-plan.js";
import { deleteTool } from "./delete.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { enterPlanModeTool, exitPlanModeTool, switchModeTool } from "./mode-tools.js";
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
import { enterWorktreeTool, exitWorktreeTool } from "./worktree.js";
import { GIT_TOOLS } from "./git.js";
import { fileTreeTool } from "./tree.js";

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
export { reportGoalMetTool } from "./report-goal-met.js";
export { completeStepTool } from "./complete-step.js";
export { createWaitJobsTool } from "./wait-jobs.js";
export { enterWorktreeTool, exitWorktreeTool } from "./worktree.js";
export {
  GIT_TOOLS,
  gitStatusTool,
  gitLogTool,
  gitDiffTool,
  gitBlameTool,
  gitAddTool,
  gitCommitTool,
  gitBranchTool,
  gitStashTool,
  gitFetchTool,
  gitPullTool,
  gitPushTool,
} from "./git.js";
export { notebookEditTool } from "./notebook-edit.js";
export { fileTreeTool } from "./tree.js";
export { envInfoTool } from "./env-info.js";
export { diffTextTool, lcsDiff } from "./diff.js";
export { processListTool, redactArgs } from "./process-list.js";
export { globToRegExp, matchGlob } from "./globmatch.js";
export { commitFileMutation, applyFileMutationDirect } from "./file-mutation.js";
export type { FileMutationRequest, FileMutationOp } from "./file-mutation.js";
export {
  createTaskTool,
  TASK_SUBAGENT_CATALOG_MARKER,
  type TaskToolOptions,
  type TaskRunResult,
} from "./task.js";
export { createCodebaseSearchTool, type CodebaseSearchHit } from "./codebase-search.js";
import { createForgetTool, createMemoryTool, createRememberTool } from "./memory.js";

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
  createRememberTool(),
  createForgetTool(),
  createMemoryTool(),
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
  ...GIT_TOOLS,
  fileTreeTool,
  reportGoalMetTool,
];

export function createBuiltinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);
  return registry;
}
