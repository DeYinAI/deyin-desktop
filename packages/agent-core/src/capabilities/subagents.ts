import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fmBool, fmString, parseFrontmatter } from "./frontmatter.js";
import type { CapabilityRoot } from "./paths.js";

export interface SubagentDefinition {
  /** Lowercase-hyphen name; the Task tool and /name invocation use it. */
  name: string;
  /** Drives delegation: the parent model picks subagents by description. */
  description: string;
  /** System prompt body for the subagent. */
  prompt: string;
  /** Model id, or undefined to inherit the parent's model. */
  model?: string;
  /** Read-only subagents get write/edit denied and bash asked. */
  readonly: boolean;
  /** Background subagents return immediately; completion surfaces as an event. */
  isBackground: boolean;
  source: string;
  path?: string;
}

/** Subagents shipped with Deyin. */
export const BUILTIN_SUBAGENTS: SubagentDefinition[] = [
  {
    name: "explorer",
    description:
      "Fast read-only codebase exploration: find files, symbols, call sites and answer questions about structure. Use proactively for broad searches to keep noisy output out of the main context.",
    prompt:
      "You are a codebase exploration subagent. Investigate the question using read/grep/glob/ls only, in parallel where possible. Report findings as a compact, structured summary with exact file paths and line references. Never modify anything.",
    readonly: true,
    isBackground: false,
    source: "built-in",
  },
  {
    name: "reviewer",
    description: "Independent second pass that critiques a diff or recent changes for correctness, security and style.",
    prompt:
      "You are a code review subagent. Review the changes described in the prompt: read the touched files, look for correctness bugs, security issues, missed edge cases and style drift. Report a prioritized list of findings with file:line references. Never modify anything.",
    readonly: true,
    isBackground: false,
    source: "built-in",
  },
  {
    name: "test-runner",
    description: "Runs the test suite (or a named subset) and reports failures with the relevant output.",
    prompt:
      "You are a test-runner subagent. Figure out how this project runs its tests (package.json scripts, Makefile, CI config), run the requested tests with bash, and report pass/fail with the failing output trimmed to what matters.",
    readonly: false,
    isBackground: false,
    source: "built-in",
  },
];

/** Discover custom subagents: one markdown file per agent. */
export async function discoverSubagents(roots: CapabilityRoot[]): Promise<SubagentDefinition[]> {
  const byName = new Map<string, SubagentDefinition>();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== ".md") continue;
      const path = join(root.dir, entry.name);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(raw);
      const name = (fmString(data, "name") ?? basename(entry.name, ".md")).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      if (!name || byName.has(name)) continue;
      byName.set(name, {
        name,
        description: fmString(data, "description") ?? `Custom subagent ${name}.`,
        prompt: body.trim() || `You are the ${name} subagent. Complete the delegated task and report back concisely.`,
        model: fmString(data, "model"),
        readonly: fmBool(data, "readonly") ?? false,
        isBackground: fmBool(data, "is_background") ?? false,
        source: root.source,
        path,
      });
    }
  }
  for (const builtin of BUILTIN_SUBAGENTS) {
    if (!byName.has(builtin.name)) byName.set(builtin.name, builtin);
  }
  return [...byName.values()];
}
