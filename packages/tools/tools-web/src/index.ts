/** Web tool family plugin: keyless web search and page fetch. */
import type { PluginDefinition } from "@deyin/extension-api";
import { Tools } from "@deyin/tools";
import { webFetchTool, websearchTool } from "@deyin/agent-core";

export const WEB_TOOLS = [websearchTool, webFetchTool];

export const toolsWebPlugin: PluginDefinition = {
  name: "@deyin/plugin-tools-web",
  inject: ["tools"],
  apply: (ctx) => {
    ctx.get(Tools).add(WEB_TOOLS);
  },
};
