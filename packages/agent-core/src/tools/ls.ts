import { readdir } from "node:fs/promises";
import type { ToolDefinition } from "../types.js";
import { asOptionalString, resolvePath } from "./util.js";

const MAX_ENTRIES = 500;

export const lsTool: ToolDefinition = {
  name: "ls",
  description: "List the entries of a directory (directories are suffixed with /).",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list (defaults to the workspace root)." },
    },
  },
  summarize: (args) => String(args.path ?? "."),
  async execute(args, ctx): Promise<string> {
    const dir = asOptionalString(args.path) ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
    });
    const shown = entries.slice(0, MAX_ENTRIES);
    const lines = shown.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (entries.length > shown.length) lines.push(`... (${entries.length - shown.length} more)`);
    return lines.length > 0 ? lines.join("\n") : "(empty directory)";
  },
};
