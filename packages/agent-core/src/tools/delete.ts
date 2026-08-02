import type { ToolDefinition } from "../types.js";
import { commitFileMutation, readFileForMutation } from "./file-mutation.js";
import { asString, resolvePathInWorkspace } from "./util.js";

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
    const abs = resolvePathInWorkspace(ctx.cwd, rel);
    try {
      const before = await readFileForMutation(abs);
      const outcome = await commitFileMutation({ path: abs, before, after: "", operation: "delete" }, ctx);
      if (outcome === "rejected") {
        return "Delete rejected by the user during review. Do not retry; ask what to do next.";
      }
      return `Deleted ${rel}`;
    } catch (err) {
      return `ERROR deleting ${rel}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
