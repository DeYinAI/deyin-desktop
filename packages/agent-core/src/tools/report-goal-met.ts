import type { ToolDefinition } from "../types.js";
import { asOptionalBoolean, asString } from "./util.js";

export const reportGoalMetTool: ToolDefinition = {
  name: "report_goal_met",
  description:
    "Report whether the active goal has been met. Call with met=true only when the verifiable objective is fully satisfied; otherwise met=false with a short reason.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      met: { type: "boolean", description: "True when the goal is verifiably complete." },
      reason: { type: "string", description: "Brief explanation of goal status." },
    },
    required: ["met", "reason"],
  },
  summarize: (args) => (args.met === true ? "goal met" : "goal not met"),
  async execute(args, ctx): Promise<string> {
    const met = asOptionalBoolean(args.met) ?? false;
    const reason = asString(args.reason, "reason");
    if (met && !ctx.goalText) {
      throw new Error("No active goal on this thread — cannot report goal met.");
    }
    if (ctx.onGoalReport) {
      ctx.onGoalReport({ met, reason });
      return met
        ? `Goal marked as met: ${reason}`
        : `Goal not yet met: ${reason}. Continue working toward the objective.`;
    }
    return "No active goal on this thread.";
  },
};
