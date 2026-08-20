/** Image tool family plugin: text-to-image generation into the chat. */
import type { PluginDefinition } from "@deyin/extension-api";
import { Tools } from "@deyin/tools";
import { generateImageTool } from "@deyin/agent-core";

export const IMAGE_TOOLS = [generateImageTool];

export const toolsImagePlugin: PluginDefinition = {
  name: "@deyin/plugin-tools-image",
  inject: ["tools"],
  apply: (ctx) => {
    ctx.get(Tools).add(IMAGE_TOOLS);
  },
};
