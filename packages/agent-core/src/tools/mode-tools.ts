import type { ModeChangeRequest, ToolDefinition } from "../types.js";

async function changeMode(ctx: Parameters<ToolDefinition["execute"]>[1], change: ModeChangeRequest): Promise<string> {
  if (!ctx.onModeChange) {
    return "Mode switching is not available in this environment.";
  }
  return ctx.onModeChange(change);
}

export const enterPlanModeTool: ToolDefinition = {
  name: "enter_plan_mode",
  description:
    "Enter read-only plan mode to explore the codebase and design an implementation strategy. Prefer this over ask_question when the task needs planning.",
  tier: "interaction",
  parameters: {
    type: "object",
    properties: {
      explanation: { type: "string", description: "Why you are entering plan mode." },
    },
  },
  summarize: () => "enter plan mode",
  async execute(args, ctx): Promise<string> {
    const explanation = typeof args.explanation === "string" ? args.explanation : undefined;
    return changeMode(ctx, {
      event: "enter",
      target: "plan",
      previous: (ctx.sessionMeta?.mode as ModeChangeRequest["previous"]) ?? "agent",
      explanation,
    });
  },
};

export const exitPlanModeTool: ToolDefinition = {
  name: "exit_plan_mode",
  description:
    "Exit plan mode and present the plan for user approval. Only call when you have a complete plan. Set userApproved when the user has explicitly approved via the UI.",
  tier: "interaction",
  parameters: {
    type: "object",
    properties: {
      userApproved: {
        type: "boolean",
        description: "True when the user approved the plan in the UI.",
      },
    },
  },
  summarize: () => "exit plan mode",
  async execute(args, ctx): Promise<string> {
    const userApproved = args.userApproved === true;
    const previous = (ctx.sessionMeta?.mode === "plan"
      ? "agent"
      : (ctx.sessionMeta?.mode as ModeChangeRequest["previous"])) ?? "agent";
    return changeMode(ctx, {
      event: "exit",
      target: previous,
      previous: "plan",
      userApproved,
    });
  },
};

export const switchModeTool: ToolDefinition = {
  name: "switch_mode",
  description:
    "Switch the composer mode programmatically. Use target_mode_id agent, plan, or ask. Include a brief explanation.",
  tier: "interaction",
  parameters: {
    type: "object",
    properties: {
      target_mode_id: {
        type: "string",
        enum: ["agent", "plan", "ask", "delivery"],
        description: "The mode to switch to.",
      },
      explanation: { type: "string", description: "Why you are switching modes." },
    },
    required: ["target_mode_id"],
  },
  summarize: (args) => `switch to ${String(args.target_mode_id ?? "agent")}`,
  async execute(args, ctx): Promise<string> {
    const target = args.target_mode_id;
    if (target !== "agent" && target !== "plan" && target !== "ask" && target !== "delivery") {
      return "ERROR: target_mode_id must be agent, plan, ask, or delivery.";
    }
    const explanation = typeof args.explanation === "string" ? args.explanation : undefined;
    return changeMode(ctx, {
      event: "switch",
      target,
      previous: (ctx.sessionMeta?.mode as ModeChangeRequest["previous"]) ?? "agent",
      explanation,
    });
  },
};
