import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTodos, todoTool } from "../src/tools/todo.js";
import type { TodoItem, ToolContext } from "../src/types.js";

function ctx(initial: TodoItem[] = []): ToolContext & { changes: TodoItem[][] } {
  const changes: TodoItem[][] = [];
  const todos = [...initial];
  return {
    cwd: process.cwd(),
    todos,
    onTodosChanged: (next) => changes.push(next.map((t) => ({ ...t }))),
    changes,
  };
}

test("renderTodos formats each status mark", () => {
  assert.equal(renderTodos([]), "(todo list is empty)");
  assert.equal(
    renderTodos([
      { id: "1", content: "A", status: "pending" },
      { id: "2", content: "B", status: "in_progress" },
      { id: "3", content: "C", status: "completed" },
      { id: "4", content: "D", status: "cancelled" },
    ]),
    "[ ] A\n[~] B\n[x] C\n[-] D",
  );
});

test("todo_write replaces the list, normalizes ids/status, and notifies listeners", async () => {
  const toolCtx = ctx([{ id: "old", content: "stale", status: "completed" }]);
  const result = await todoTool.execute(
    {
      todos: [
        { content: "Ship plan", status: "pending" },
        { id: "keep", content: "Wire UI", status: "in_progress" },
        { id: "", content: "Skip empty status", status: "nope" },
        { content: "", status: "pending" },
        { content: "Drop cancelled later", status: "cancelled" },
      ],
    },
    toolCtx,
  );

  assert.deepEqual(toolCtx.todos, [
    { id: "t1", content: "Ship plan", status: "pending" },
    { id: "keep", content: "Wire UI", status: "in_progress" },
    { id: "t3", content: "Skip empty status", status: "pending" },
    { id: "t5", content: "Drop cancelled later", status: "cancelled" },
  ]);
  assert.equal(toolCtx.changes.length, 1);
  assert.deepEqual(toolCtx.changes[0], toolCtx.todos);
  assert.match(result, /\[ \] Ship plan/);
  assert.match(result, /\[~\] Wire UI/);
});

test("todo_write preserves acceptanceCriteria for delivery mode", async () => {
  const toolCtx = ctx();
  await todoTool.execute(
    {
      todos: [{ id: "s1", content: "Add tests", status: "pending", acceptanceCriteria: "npm test passes" }],
    },
    toolCtx,
  );
  assert.equal(toolCtx.todos[0]?.acceptanceCriteria, "npm test passes");
});

test("todo_write summarize reports completed/total", () => {
  const summary = todoTool.summarize({
    todos: [
      { id: "1", content: "A", status: "completed" },
      { id: "2", content: "B", status: "pending" },
      { id: "3", content: "C", status: "completed" },
    ],
  });
  assert.equal(summary, "2/3 completed");
});
