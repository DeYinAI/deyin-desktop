/**
 * Filesystem tool family plugin. Implementations live in @deyin/agent-core;
 * this package only contributes them to the tools seam so hosts and other
 * families never hard-import tool code.
 */
import type { PluginDefinition } from "@deyin/extension-api";
import { Tools } from "@deyin/tools";
import { deleteTool, editTool, fileTreeTool, globTool, grepTool, lsTool, readTool, writeTool } from "@deyin/agent-core";

export const FS_TOOLS = [readTool, writeTool, editTool, deleteTool, grepTool, globTool, lsTool, fileTreeTool];

export const toolsFsPlugin: PluginDefinition = {
  name: "@deyin/plugin-tools-fs",
  inject: ["tools"],
  apply: (ctx) => {
    ctx.get(Tools).add(FS_TOOLS);
  },
};
