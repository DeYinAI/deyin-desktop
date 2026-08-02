import type { TodoItem, ToolDefinition } from "../types.js";

const STATUS_MARK: Record<TodoItem["status"], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
};

export function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "(todo list is empty)";
  return todos.map((t) => `${STATUS_MARK[t.status]} ${t.content}`).join("\n");
}

export const todoTool: ToolDefinition = {
  name: "todo_write",
  description:
    "Replace the session todo list. Pass the complete list every time (including unchanged items). Use for multi-step tasks to track progress; mark items in_progress when started and completed when done.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The full todo list.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable identifier." },
            content: { type: "string", description: "Short imperative description." },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            acceptanceCriteria: {
              type: "string",
              description: "Delivery mode: how to verify this step (tests, commands, observable outcomes).",
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  summarize: (args) => {
    const todos = Array.isArray(args.todos) ? (args.todos as TodoItem[]) : [];
    const done = todos.filter((t) => t.status === "completed").length;
    return `${done}/${todos.length} completed`;
  },
  async execute(args, ctx): Promise<string> {
    const raw = Array.isArray(args.todos) ? args.todos : [];
    const todos: TodoItem[] = raw
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t, i) => {
        const item: TodoItem = {
          id: typeof t.id === "string" && t.id ? t.id : `t${i + 1}`,
          content: typeof t.content === "string" ? t.content : "",
          status: (["pending", "in_progress", "completed", "cancelled"] as const).includes(
            t.status as TodoItem["status"],
          )
            ? (t.status as TodoItem["status"])
            : "pending",
        };
        if (typeof t.acceptanceCriteria === "string" && t.acceptanceCriteria.trim()) {
          item.acceptanceCriteria = t.acceptanceCriteria.trim();
        }
        if (t.signedOff === true) item.signedOff = true;
        if (typeof t.signOffNotes === "string" && t.signOffNotes.trim()) {
          item.signOffNotes = t.signOffNotes.trim();
        }
        return item;
      })
      .filter((t) => t.content.length > 0);

    ctx.todos.splice(0, ctx.todos.length, ...todos);
    ctx.onTodosChanged?.(ctx.todos);
    return renderTodos(ctx.todos);
  },
};
