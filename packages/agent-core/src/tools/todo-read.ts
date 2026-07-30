import type { ToolDefinition } from "../types.js";
import { renderTodos } from "./todo.js";

export const todoReadTool: ToolDefinition = {
  name: "todo_read",
  description: "Read the current session todo list and return its status.",
  tier: "read",
  parameters: { type: "object", properties: {} },
  summarize: () => "read todos",
  async execute(_args, ctx): Promise<string> {
    return renderTodos(ctx.todos);
  },
};
