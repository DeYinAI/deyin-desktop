import type { ToolDefinition } from "../types.js";
import { commitFileMutation, readFileForMutation } from "./file-mutation.js";
import { asString, resolvePathInWorkspace } from "./util.js";

export const writeTool: ToolDefinition = {
  name: "write",
  description:
    "Create or overwrite a file with the given content. Creates parent directories as needed. Prefer the edit tool for small changes to existing files.",
  tier: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to the workspace root)." },
      content: { type: "string", description: "Full file content to write." },
    },
    required: ["path", "content"],
  },
  summarize: (args) => String(args.path ?? ""),
  async execute(args, ctx): Promise<string> {
    const path = resolvePathInWorkspace(ctx.cwd, asString(args.path, "path"));
    const content = typeof args.content === "string" ? args.content : "";
    const before = await readFileForMutation(path);
    const outcome = await commitFileMutation({ path, before, after: content, operation: "write" }, ctx);
    if (outcome === "rejected") {
      return "Change rejected by the user during review. Do not retry the same edit; ask what to do next.";
    }
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
  },
};
