/** Agent-state tool family plugin: memory, skills, session context, messaging, worktrees, questions. */
import type { PluginDefinition } from "@deyin/extension-api";
import { Tools } from "@deyin/tools";
import {
  askQuestionTool,
  awaitTaskTool,
  createForgetTool,
  createMemoryTool,
  createRememberTool,
  createWaitJobsTool,
  enterWorktreeTool,
  exitWorktreeTool,
  readSessionContextTool,
  sendMessageTool,
  skillTool,
} from "@deyin/agent-core";

export const AGENT_STATE_TOOLS = [
  createRememberTool(),
  createForgetTool(),
  createMemoryTool(),
  skillTool,
  readSessionContextTool,
  sendMessageTool,
  awaitTaskTool,
  createWaitJobsTool(),
  enterWorktreeTool,
  exitWorktreeTool,
  askQuestionTool,
];

export const toolsAgentPlugin: PluginDefinition = {
  name: "@deyin/plugin-tools-agent",
  inject: ["tools"],
  apply: (ctx) => {
    ctx.get(Tools).add(AGENT_STATE_TOOLS);
  },
};
