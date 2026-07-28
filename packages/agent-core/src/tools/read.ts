import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "../types.js";
import { asOptionalNumber, asString, resolvePath } from "./util.js";

const MAX_BYTES = 1_000_000;
const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;

export const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read a text file. Returns numbered lines. Use offset/limit for large files. Always read a file before editing it.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to the workspace root)." },
      offset: { type: "number", description: "1-based line number to start from (default 1)." },
      limit: { type: "number", description: `Maximum number of lines to return (default ${DEFAULT_LIMIT}).` },
    },
    required: ["path"],
  },
  summarize: (args) => String(args.path ?? ""),
  async execute(args, ctx): Promise<string> {
    const path = resolvePath(ctx.cwd, asString(args.path, "path"));
    const offset = Math.max(1, asOptionalNumber(args.offset) ?? 1);
    const limit = Math.max(1, asOptionalNumber(args.limit) ?? DEFAULT_LIMIT);

    const buf = await readFile(path);
    const capped = buf.subarray(0, MAX_BYTES);
    if (capped.includes(0)) return `(binary file, ${buf.length} bytes)`;

    const lines = capped.toString("utf8").split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice
      .map((line, i) => {
        const n = offset + i;
        const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
        return `${String(n).padStart(6)}\t${text}`;
      })
      .join("\n");

    const notes: string[] = [];
    if (buf.length > MAX_BYTES) notes.push(`file truncated at ${MAX_BYTES} bytes`);
    if (offset - 1 + limit < lines.length) notes.push(`showing lines ${offset}-${offset - 1 + slice.length} of ${lines.length}`);
    return notes.length > 0 ? `${body}\n(${notes.join("; ")})` : body;
  },
};
