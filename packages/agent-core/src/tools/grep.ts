import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition } from "../types.js";
import { matchGlob } from "./globmatch.js";
import { IGNORED_DIRS, asOptionalBoolean, asOptionalNumber, asOptionalString, asString, resolvePath, truncate } from "./util.js";

const DEFAULT_MAX_RESULTS = 100;
const MAX_FILE_BYTES = 1_000_000;

function runRipgrep(args: string[], cwd: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("rg", args, { cwd, signal, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", () => resolvePromise({ ok: false, output: "" })); // rg not installed
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ ok: true, output: stdout });
      else if (code === 1) resolvePromise({ ok: true, output: "" }); // no matches
      else resolvePromise({ ok: false, output: stderr });
    });
  });
}

async function jsGrep(
  pattern: RegExp,
  root: string,
  glob: string | undefined,
  maxResults: number,
): Promise<string[]> {
  const results: string[] = [];
  const queue = [root];
  while (queue.length > 0 && results.length < maxResults) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, full);
      if (glob && !matchGlob(rel, glob)) continue;
      try {
        const info = await stat(full);
        if (info.size > MAX_FILE_BYTES) continue;
        const buf = await readFile(full);
        if (buf.includes(0)) continue; // binary
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          if (pattern.test(lines[i]!)) results.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 400)}`);
        }
      } catch {
        // unreadable file: skip
      }
    }
  }
  return results;
}

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns file:line:text matches. Uses ripgrep when available. Filter files with the glob parameter (e.g. \"*.ts\").",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "Directory to search (defaults to the workspace root)." },
      glob: { type: "string", description: "Only search files matching this glob (e.g. \"*.tsx\", \"src/**/*.ts\")." },
      ignore_case: { type: "boolean", description: "Case-insensitive search (default false)." },
      max_results: { type: "number", description: `Cap on returned matches (default ${DEFAULT_MAX_RESULTS}).` },
    },
    required: ["pattern"],
  },
  summarize: (args) => `/${String(args.pattern ?? "")}/${args.glob ? ` in ${String(args.glob)}` : ""}`,
  async execute(args, ctx): Promise<string> {
    const pattern = asString(args.pattern, "pattern");
    const root = asOptionalString(args.path) ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;
    const glob = asOptionalString(args.glob);
    const ignoreCase = asOptionalBoolean(args.ignore_case) ?? false;
    const maxResults = asOptionalNumber(args.max_results) ?? DEFAULT_MAX_RESULTS;

    const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--max-count", "20", "-e", pattern];
    if (ignoreCase) rgArgs.push("-i");
    if (glob) rgArgs.push("--glob", glob);
    rgArgs.push("./");

    const rg = await runRipgrep(rgArgs, root, ctx.signal);
    if (rg.ok) {
      const lines = rg.output.split("\n").filter(Boolean).slice(0, maxResults);
      return lines.length > 0 ? truncate(lines.join("\n")) : "No matches found.";
    }

    // Fallback: pure-JS walk (rg missing or errored).
    const re = new RegExp(pattern, ignoreCase ? "i" : undefined);
    const results = await jsGrep(re, root, glob, maxResults);
    return results.length > 0 ? truncate(results.join("\n")) : "No matches found.";
  },
};
