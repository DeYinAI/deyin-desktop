import type { ToolDefinition } from "../types.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import { ToolRegistry } from "./registry.js";
import { todoTool } from "./todo.js";
import { websearchTool } from "./websearch.js";
import { writeTool } from "./write.js";

export { ToolRegistry } from "./registry.js";
export { bashTool, effectiveShell } from "./bash.js";
export { readTool } from "./read.js";
export { writeTool } from "./write.js";
export { editTool, applyEdit, countOccurrences } from "./edit.js";
export { grepTool } from "./grep.js";
export { globTool } from "./glob.js";
export { lsTool } from "./ls.js";
export { websearchTool } from "./websearch.js";
export { todoTool, renderTodos } from "./todo.js";
export { globToRegExp, matchGlob } from "./globmatch.js";
export {
  createTaskTool,
  TASK_SUBAGENT_CATALOG_MARKER,
  type TaskToolOptions,
  type TaskRunResult,
} from "./task.js";
export { createCodebaseSearchTool, type CodebaseSearchHit } from "./codebase-search.js";

export const BUILTIN_TOOLS: ToolDefinition[] = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  grepTool,
  globTool,
  lsTool,
  websearchTool,
  todoTool,
];

export function createBuiltinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);
  return registry;
}
