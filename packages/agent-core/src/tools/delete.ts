import { unlink } from "node:fs/promises";
import type { ToolDefinition } from "../types.js";
import { asString, resolvePath } from "./util.js";

export const deleteTool: ToolDefinition = {
  name: "delete",
  description: "Delete a file in the workspace. Does not delete directories.",
  tier: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path of the file to delete." },
    },
    required: ["path"],
  },
  summarize: (args) => String(args.path ?? ""),
  async execute(args, ctx): Promise<string> {
    const rel = asString(args.path, "path");
    const abs = resolvePath(ctx.cwd, rel);
    try {
      await unlink(abs);
      return `Deleted ${rel}`;
    } catch (err) {
      return `ERROR deleting ${rel}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
