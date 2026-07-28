import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition } from "../types.js";
import { asString, resolvePath } from "./util.js";

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
    const path = resolvePath(ctx.cwd, asString(args.path, "path"));
    const content = typeof args.content === "string" ? args.content : "";
    const before = await readFile(path, "utf8").catch(() => "");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    ctx.onFileChanged?.({ path, before, after: content });
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
  },
};
