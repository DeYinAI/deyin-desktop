import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fmString, parseFrontmatter } from "./frontmatter.js";
import type { CapabilityRoot } from "./paths.js";

export interface CommandDefinition {
  /** Invoked as /name; the filename without extension. */
  name: string;
  description: string;
  /** Prompt template; $ARGUMENTS is replaced with the text after the command. */
  body: string;
  source: string;
  path?: string;
}

const COMMAND_EXTENSIONS = new Set([".md", ".mdc", ".markdown", ".txt"]);

/** Commands shipped with Deyin. Authoring workflows (create-skill, create-rule,
 *  create-hook, create-subagent) ship as built-in skills instead. */
export const BUILTIN_COMMANDS: CommandDefinition[] = [
  {
    name: "commit",
    description: "Stage everything and write a conventional commit message.",
    source: "built-in",
    body: "Stage all changes and create a git commit. Inspect `git status` and `git diff` first, then write a concise conventional-commit message describing why the change was made. $ARGUMENTS",
  },
  {
    name: "explain",
    description: "Explain the selected code or the last terminal error.",
    source: "built-in",
    body: "Explain the following (or, when empty, the most recent error in the conversation) clearly and concisely, with the key mechanism first: $ARGUMENTS",
  },
  {
    name: "fix",
    description: "Propose and apply a fix for the current diagnostics.",
    source: "built-in",
    body: "Find and fix the problem described here (or the most recent error in this conversation): $ARGUMENTS. Reproduce it first when possible, apply the smallest correct fix, then verify.",
  },
];

/** Discover commands: one file per command, filename = command name. */
export async function discoverCommands(roots: CapabilityRoot[]): Promise<CommandDefinition[]> {
  const byName = new Map<string, CommandDefinition>();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !COMMAND_EXTENSIONS.has(extname(entry.name))) continue;
      const path = join(root.dir, entry.name);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(raw);
      const name = (fmString(data, "name") ?? basename(entry.name, extname(entry.name)))
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-");
      if (!name || byName.has(name)) continue;
      byName.set(name, {
        name,
        description: fmString(data, "description") ?? firstLine(body) ?? `/${name}`,
        body: body.trim(),
        source: root.source,
        path,
      });
    }
  }
  for (const builtin of BUILTIN_COMMANDS) {
    if (!byName.has(builtin.name)) byName.set(builtin.name, builtin);
  }
  return [...byName.values()];
}

function firstLine(body: string): string | undefined {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
}

/** Expand a command invocation into the prompt sent to the model. */
export function expandCommand(command: CommandDefinition, args: string): string {
  if (command.body.includes("$ARGUMENTS")) return command.body.replaceAll("$ARGUMENTS", args.trim());
  return args.trim() ? `${command.body}\n\n${args.trim()}` : command.body;
}

/**
 * Match "/name rest" at the start of a prompt against known commands (and
 * skills invoked as commands). Returns null when the prompt is not a command.
 */
export function matchCommand(prompt: string): { name: string; args: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)\s?([\s\S]*)$/i.exec(prompt.trim());
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: match[2] ?? "" };
}
