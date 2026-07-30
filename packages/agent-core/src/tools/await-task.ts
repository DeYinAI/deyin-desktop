import type { ToolDefinition } from "../types.js";
import { asOptionalNumber, asString } from "./util.js";

export const awaitTaskTool: ToolDefinition = {
  name: "await",
  description:
    "Poll a background shell task by task_id until it completes or the timeout elapses. Use after starting a background command.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Background task identifier." },
      block_until_ms: {
        type: "number",
        description: "Max time to wait in milliseconds (default 30000).",
      },
    },
    required: ["task_id"],
  },
  summarize: (args) => `await ${String(args.task_id ?? "")}`,
  async execute(args, ctx): Promise<string> {
    const taskId = asString(args.task_id, "task_id");
    const blockUntilMs = asOptionalNumber(args.block_until_ms) ?? 30_000;
    if (!ctx.pollBackgroundTask) {
      return `Background task polling is not available. Task "${taskId}" status unknown.`;
    }
    return ctx.pollBackgroundTask(taskId, blockUntilMs);
  },
};
