import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PlanArtifact, TodoItem, ToolDefinition } from "../types.js";
import { renderTodos } from "./todo.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildPlanMarkdown(plan: PlanArtifact): string {
  const lines = ["---", `name: ${JSON.stringify(plan.name)}`];
  if (plan.overview) lines.push(`overview: ${JSON.stringify(plan.overview)}`);
  lines.push(`created: ${new Date().toISOString()}`, "---", "", plan.plan.trim());
  return `${lines.join("\n")}\n`;
}

export const createPlanTool: ToolDefinition = {
  name: "create_plan",
  description:
    "Write a formal plan artifact to disk and present it to the user for approval. Call after research and todo_write. The plan markdown should include a # heading, summary, and numbered implementation steps.",
  tier: "interaction",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short 3-4 word plan name." },
      overview: { type: "string", description: "1-2 sentence summary." },
      plan: { type: "string", description: "Full markdown plan body." },
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
          },
          required: ["content"],
        },
      },
    },
    required: ["plan"],
  },
  summarize: (args) => String(args.name ?? "plan"),
  async execute(args, ctx): Promise<string> {
    const planBody = typeof args.plan === "string" ? args.plan.trim() : "";
    if (!planBody) return "ERROR: create_plan requires a non-empty plan markdown body.";

    const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "Implementation plan";
    const overview = typeof args.overview === "string" ? args.overview.trim() : undefined;

    const rawTodos = Array.isArray(args.todos) ? args.todos : [];
    const todos: TodoItem[] = rawTodos
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t, i) => ({
        id: typeof t.id === "string" && t.id ? t.id : `step-${i + 1}`,
        content: typeof t.content === "string" ? t.content : "",
        status: "pending" as const,
      }))
      .filter((t) => t.content.length > 0);

    if (todos.length > 0) {
      ctx.todos.splice(0, ctx.todos.length, ...todos);
      ctx.onTodosChanged?.(ctx.todos);
    }

    const artifact: PlanArtifact = { name, overview, plan: planBody, todos: todos.length > 0 ? todos : undefined };
    const plansDir = ctx.plansDir ?? join(homedir(), ".deyin", "plans");
    await mkdir(plansDir, { recursive: true });
    const fileName = `${slugify(name) || "plan"}-${randomUUID().slice(0, 8)}.plan.md`;
    const filePath = join(plansDir, fileName);
    await writeFile(filePath, buildPlanMarkdown(artifact), "utf8");
    artifact.filePath = filePath;

    ctx.onPlanCreated?.(artifact);

    const todoLine = todos.length > 0 ? `\n\nTodos:\n${renderTodos(todos)}` : "";
    return `Plan "${name}" created at ${filePath}.${todoLine}\n\nPresent this plan to the user and wait for approval before implementing.`;
  },
};
