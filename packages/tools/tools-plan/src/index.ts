/** Planning tool family plugin: todos, plan/mode switching, goal reporting. */
import type { PluginDefinition } from "@deyin/extension-api";
import { Tools } from "@deyin/tools";
import {
  createPlanTool,
  enterPlanModeTool,
  exitPlanModeTool,
  reportGoalMetTool,
  switchModeTool,
  todoReadTool,
  todoTool,
} from "@deyin/agent-core";

export const PLAN_TOOLS = [
  todoTool,
  todoReadTool,
  createPlanTool,
  enterPlanModeTool,
  exitPlanModeTool,
  switchModeTool,
  reportGoalMetTool,
];

export const toolsPlanPlugin: PluginDefinition = {
  name: "@deyin/plugin-tools-plan",
  inject: ["tools"],
  apply: (ctx) => {
    ctx.get(Tools).add(PLAN_TOOLS);
  },
};
