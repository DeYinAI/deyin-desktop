import { ToolRegistry } from "../tools/registry.js";
import { createUseCapabilityTool, type UseCapabilityOptions } from "../tools/use-capability.js";

/** Read-only tools exposed to the planner (no side effects, no recursion). */
export const PLANNER_ALLOWED_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "codebase_search",
  "websearch",
  "web_fetch",
  "todo_write",
  "todo_read",
  "ask_question",
  "use_capability",
  "read_session_context",
]);

export interface PlannerRegistryOptions extends UseCapabilityOptions {
  /** Full executor registry to filter from. */
  source: ToolRegistry;
}

/**
 * Build a read-only tool registry for the planner agent.
 * Includes use_capability MCP proxy to preserve prefix cache stability.
 */
export function createPlannerRegistry(opts: PlannerRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of opts.source.list()) {
    if (PLANNER_ALLOWED_TOOLS.has(tool.name)) {
      registry.register(tool);
    }
  }
  registry.register(createUseCapabilityTool(opts));
  return registry;
}

export function assertPlannerCannotWrite(registry: ToolRegistry): void {
  const forbidden = ["write", "edit", "delete", "bash", "task", "fleet", "notebook_edit"];
  for (const name of forbidden) {
    if (registry.get(name)) {
      throw new Error(`planner registry must not include write tool: ${name}`);
    }
  }
}

export function plannerMaxSteps(depth: "light" | "full"): number {
  return depth === "full" ? 6 : 2;
}
