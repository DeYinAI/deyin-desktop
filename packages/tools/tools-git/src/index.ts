/** Git tool family plugin: the full read/write git suite. */
import type { PluginDefinition } from "@deyin/extension-api";
import { Tools } from "@deyin/tools";
import { GIT_TOOLS } from "@deyin/agent-core";

export const GIT_FAMILY_TOOLS = [...GIT_TOOLS];

export const toolsGitPlugin: PluginDefinition = {
  name: "@deyin/plugin-tools-git",
  inject: ["tools"],
  apply: (ctx) => {
    ctx.get(Tools).add(GIT_FAMILY_TOOLS);
  },
};
