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
 * Match "/name rest" at the start of a prompt. Returns null when the prompt is
 * not a command invocation.
 *
 * The name must be followed by whitespace or end of input. That is what keeps a
 * message opening with an absolute path — `/home/me/notes.md`, `/dev/null` —
 * from being read as a call to a command named `home` or `dev`, which in turn is
 * what lets an unrecognised name be reported instead of silently forwarded to
 * the model as prose.
 */
export function matchCommand(prompt: string): { name: string; args: string } | null {
  const match = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: match[2] ?? "" };
}

/** Outcome of resolving a leading "/name" against the run's capabilities. */
export type CommandResolution =
  | { kind: "none" }
  | { kind: "command"; name: string; prompt: string }
  | { kind: "skill"; name: string; prompt: string }
  | { kind: "unknown"; name: string; suggestions: string[] };

/** Edit distance ≤ 2 (or a shared prefix) counts as "did you mean". */
function isNearMiss(typed: string, candidate: string): boolean {
  if (candidate.startsWith(typed) || typed.startsWith(candidate)) return true;
  if (Math.abs(typed.length - candidate.length) > 2) return false;
  // Levenshtein, capped at 3 — the strings here are short command names.
  const prev = Array.from({ length: candidate.length + 1 }, (_, i) => i);
  const row = new Array<number>(candidate.length + 1);
  for (let i = 1; i <= typed.length; i++) {
    row[0] = i;
    for (let j = 1; j <= candidate.length; j++) {
      const cost = typed[i - 1] === candidate[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= candidate.length; j++) prev[j] = row[j]!;
  }
  return prev[candidate.length]! <= 2;
}

/**
 * Resolve a prompt that may open with "/name" into the text actually sent to
 * the model. Commands expand their template; skills become an instruction to
 * read the SKILL.md; an unrecognised name resolves to `unknown` so the host can
 * tell the user instead of spending a turn on prose that starts with a slash.
 */
export function resolveCommandInvocation(
  prompt: string,
  caps: { commands: Pick<CommandDefinition, "name" | "body">[]; skills: { name: string; path: string }[] },
): CommandResolution {
  const invocation = matchCommand(prompt);
  if (!invocation) return { kind: "none" };

  const command = caps.commands.find((c) => c.name === invocation.name);
  if (command) {
    return { kind: "command", name: invocation.name, prompt: expandCommand(command as CommandDefinition, invocation.args) };
  }

  const skill = caps.skills.find((s) => s.name === invocation.name);
  if (skill) {
    return {
      kind: "skill",
      name: invocation.name,
      prompt: `Read the skill file at ${skill.path} with the read tool and follow it for this task: ${invocation.args || "(no extra arguments)"}`,
    };
  }

  const names = [...caps.commands.map((c) => c.name), ...caps.skills.map((s) => s.name)];
  const suggestions = [...new Set(names.filter((n) => isNearMiss(invocation.name, n)))].sort().slice(0, 5);
  return { kind: "unknown", name: invocation.name, suggestions };
}

/**
 * True when the prompt opens with "/name" that is not a known command or skill.
 * Name-only check, so callers that hold just a capability list (the composer)
 * can use it without the bodies and paths `resolveCommandInvocation` expands.
 */
export function isUnknownSlashCommand(
  prompt: string,
  caps: { commands: Pick<CommandDefinition, "name">[]; skills: { name: string }[] },
): boolean {
  const invocation = matchCommand(prompt);
  if (!invocation) return false;
  return (
    !caps.commands.some((c) => c.name === invocation.name) &&
    !caps.skills.some((s) => s.name === invocation.name)
  );
}

/** User-facing message for an unrecognised "/name". */
export function unknownCommandMessage(name: string, suggestions: string[]): string {
  const hint =
    suggestions.length > 0
      ? ` Did you mean ${suggestions.map((s) => `\`/${s}\``).join(", ")}?`
      : " Type `/` in the composer to see what is available.";
  return `Unknown command \`/${name}\`.${hint}`;
}
