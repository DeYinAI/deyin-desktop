import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition } from "../types.js";
import { matchGlob } from "./globmatch.js";
import { IGNORED_DIRS, asOptionalString, asString, resolvePath } from "./util.js";

const MAX_RESULTS = 200;

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    "Find files by glob pattern (e.g. \"**/*.ts\", \"src/**/config.*\"). Returns paths sorted by modification time (newest first).",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match file paths against." },
      path: { type: "string", description: "Directory to search (defaults to the workspace root)." },
    },
    required: ["pattern"],
  },
  summarize: (args) => String(args.pattern ?? ""),
  async execute(args, ctx): Promise<string> {
    const pattern = asString(args.pattern, "pattern");
    const root = asOptionalString(args.path) ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;

    const hits: { rel: string; mtime: number }[] = [];
    const queue = [root];
    while (queue.length > 0 && hits.length < 5000) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          queue.push(full);
        } else if (entry.isFile()) {
          const rel = relative(root, full);
          if (matchGlob(rel, pattern)) {
            let mtime = 0;
            try {
              mtime = (await stat(full)).mtimeMs;
            } catch {
              // keep mtime 0
            }
            hits.push({ rel, mtime });
          }
        }
      }
    }

    if (hits.length === 0) return "No files matched.";
    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, MAX_RESULTS);
    const lines = shown.map((h) => h.rel);
    if (hits.length > shown.length) lines.push(`... (${hits.length - shown.length} more)`);
    return lines.join("\n");
  },
};
