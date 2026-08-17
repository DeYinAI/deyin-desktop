/** Shell tool family plugin: bash over the persistent AgentShell PTY. */
import type { PluginDefinition } from "@deyin/extension-api";
import { Tools } from "@deyin/tools";
import { bashTool } from "@deyin/agent-core";

export const SHELL_TOOLS = [bashTool];

export const toolsShellPlugin: PluginDefinition = {
  name: "@deyin/plugin-tools-shell",
  inject: ["tools"],
  apply: (ctx) => {
    ctx.get(Tools).add(SHELL_TOOLS);
  },
};
