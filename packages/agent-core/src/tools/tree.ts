import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "../types.js";
import { IGNORED_DIRS, asOptionalNumber, asOptionalString, resolvePath } from "./util.js";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ENTRIES = 250;

/**
 * Recursive, bounded workspace tree. Skips ignored dirs (node_modules, .git,
 * dist, ...) so a single call gives the agent the shape of the codebase
 * without blowing the context window.
 */
export const fileTreeTool: ToolDefinition = {
  name: "file_tree",
  description:
    'Recursive directory tree of the workspace (or a subdirectory). Skips node_modules/.git/dist etc. Use to get the shape of the codebase: "file_tree", or "file_tree" with path="src" and max_depth=2.',
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to tree (defaults to the workspace root)." },
      max_depth: { type: "number", description: `Maximum recursion depth (default ${DEFAULT_MAX_DEPTH}).` },
      max_entries: { type: "number", description: `Cap on total entries (default ${DEFAULT_MAX_ENTRIES}).` },
    },
  },
  summarize: (args) => String(args.path ?? "."),
  async execute(args, ctx): Promise<string> {
    const root = asOptionalString(args.path) ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;
    const maxDepth = Math.min(Math.max(asOptionalNumber(args.max_depth) ?? DEFAULT_MAX_DEPTH, 1), 12);
    const maxEntries = Math.min(Math.max(asOptionalNumber(args.max_entries) ?? DEFAULT_MAX_ENTRIES, 10), 2000);

    const lines: string[] = [];
    let entries = 0;
    let skipped = 0;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (entries >= maxEntries) return;
      let children;
      try {
        children = await readdir(dir, { withFileTypes: true });
      } catch {
        lines.push(`${"  ".repeat(depth)}<unreadable: ${dir}>`);
        return;
      }
      children.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
      });
      for (const child of children) {
        if (entries >= maxEntries) return;
        if (IGNORED_DIRS.has(child.name)) {
          skipped++;
          continue;
        }
        const indent = "  ".repeat(depth);
        if (child.isDirectory()) {
          if (depth + 1 >= maxDepth) {
            lines.push(`${indent}${child.name}/ …`);
            skipped++;
            continue;
          }
          lines.push(`${indent}${child.name}/`);
          entries++;
          await walk(join(dir, child.name), depth + 1);
        } else {
          lines.push(`${indent}${child.name}`);
          entries++;
        }
      }
    };

    await walk(root, 0);
    if (lines.length === 0) return "(empty directory)";
    if (skipped > 0) lines.push(`... (${skipped} entries hidden: ignored dirs or depth cap)`);
    return lines.join("\n");
  },
};
