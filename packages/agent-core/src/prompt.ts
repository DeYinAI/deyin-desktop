import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, sep } from "node:path";
import type { AgentDefinition } from "./agents.js";
import { skillsPromptSection, type SkillDefinition } from "./capabilities/skills.js";
import type { SystemPromptSections } from "./context-usage.js";
import { effectiveShell } from "./tools/bash.js";

const MAX_CONTEXT_FILE_CHARS = 20_000;
const MAX_PARENT_LEVELS = 5;
/** Nested @import expansion depth cap (Advanced agent-style instruction imports). */
const MAX_IMPORT_DEPTH = 5;

/** Instruction files recognized in a directory, normal first then .local variants (local wins). */
const INSTRUCTION_ORDER = [
  "AGENTS.md",
  "CLAUDE.md",
  "DEYIN.md",
  "AGENTS.local.md",
  "CLAUDE.local.md",
  "DEYIN.local.md",
];

export interface ContextFile {
  path: string;
  content: string;
}

export interface LoadContextFilesOptions {
  /** Directory holding user-global instruction files (defaults to ~/.deyin). */
  userDir?: string;
}

export interface LoadContextFilesResult {
  files: ContextFile[];
  /** Import/precedence diagnostics (cycles, escapes, depth, missing imports). */
  diagnostics: string[];
}

/**
 * Load project + user instructions with Advanced agent-style layering and precedence
 * (later entries win):
 *
 *   1. user-global instruction files from `~/.deyin/` (lowest priority);
 *   2. instruction files (`AGENTS.md` / `CLAUDE.md` / `DEYIN.md` and their
 *      `.local.md` variants) walking from the farthest ancestor to cwd — deeper
 *      directories beat broader ones, and a `.local` variant beats normal files
 *      in the same directory;
 *   3. every markdown file in `<cwd>/.deyin/rules/` (highest priority).
 *
 * Standalone `@path` lines import another instruction file relative to the
 * importing file's directory (max 5 levels, no absolute paths, no parent or
 * symlink escapes, no cycles). Files whose expanded content is identical are
 * deduplicated, keeping the more specific (later) source.
 */
export async function loadContextFilesDetailed(
  cwd: string,
  opts: LoadContextFilesOptions = {},
): Promise<LoadContextFilesResult> {
  const diagnostics: string[] = [];
  const files: ContextFile[] = [];

  // 1) User-global instructions: ~/.deyin/{AGENTS,CLAUDE,DEYIN}(.local).md
  const userDir = opts.userDir ?? join(homedir(), ".deyin");
  files.push(...(await instructionFilesIn(userDir)));

  // 2) Workspace walk, farthest ancestor first so the nearest appears last.
  const dirs: string[] = [];
  let dir = cwd;
  for (let i = 0; i < MAX_PARENT_LEVELS; i++) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of dirs.reverse()) {
    files.push(...(await instructionFilesIn(d)));
  }

  // 3) Project rules.
  try {
    const rulesDir = join(cwd, ".deyin", "rules");
    const entries = await readdir(rulesDir, { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(rulesDir, entry.name);
      const content = await readOptional(path);
      if (content) files.push({ path, content });
    }
  } catch {
    // no rules dir
  }

  // 4) Expand @imports per file.
  const expanded: ContextFile[] = [];
  for (const file of files) {
    const expandedFile = await expandImports(file, new Set(), diagnostics);
    if (expandedFile) expanded.push(expandedFile);
  }

  // 5) Dedup identical expanded content, keeping the more specific (later) source.
  const byContent = new Map<string, ContextFile>();
  for (const file of expanded) byContent.set(file.content, file);
  const deduped = [...byContent.values()];

  // Re-apply the per-file cap after expansion.
  return { files: deduped.map((f) => ({ ...f, content: f.content.slice(0, MAX_CONTEXT_FILE_CHARS) })), diagnostics };
}

/** Convenience wrapper returning just the files (diagnostics dropped). */
export async function loadContextFiles(cwd: string, opts: LoadContextFilesOptions = {}): Promise<ContextFile[]> {
  return (await loadContextFilesDetailed(cwd, opts)).files;
}

/** Read the recognized instruction files of one directory in precedence order. */
async function instructionFilesIn(dir: string): Promise<ContextFile[]> {
  const out: ContextFile[] = [];
  for (const base of INSTRUCTION_ORDER) {
    const path = join(dir, base);
    const content = await readOptional(path);
    if (content) out.push({ path, content });
  }
  return out;
}

/** Expand standalone `@path` import lines, confining imports to the file's directory. */
async function expandImports(file: ContextFile, stack: Set<string>, diagnostics: string[]): Promise<ContextFile | null> {
  const real = await realpathSafe(file.path);
  if (real && stack.has(real)) {
    diagnostics.push(`import cycle at ${file.path}`);
    return null;
  }
  if (real) stack.add(real);
  const lines = file.content.split("\n");
  const parts: string[] = [];
  for (const line of lines) {
    const match = /^\s*@(\S+)\s*$/.exec(line);
    if (!match) {
      parts.push(line);
      continue;
    }
    const ref = match[1]!;
    if (stack.size > MAX_IMPORT_DEPTH) {
      diagnostics.push(`import depth exceeded at ${file.path} (${ref})`);
      parts.push(line);
      continue;
    }
    if (ref.startsWith("/") || ref.includes("..")) {
      diagnostics.push(`import "${ref}" in ${file.path} rejected (absolute or parent escape)`);
      continue;
    }
    const dirReal = await realpathSafe(dirname(file.path));
    const target = join(dirname(file.path), ref);
    const targetReal = await realpathSafe(target);
    if (targetReal === null || dirReal === null) {
      diagnostics.push(`import "${ref}" in ${file.path}: file not found`);
      continue;
    }
    if (!targetReal.startsWith(dirReal + sep)) {
      diagnostics.push(`import "${ref}" in ${file.path} rejected (escapes its directory)`);
      continue;
    }
    const nested = await expandImports({ path: target, content: await readOptional(target) ?? "" }, stack, diagnostics);
    if (nested) parts.push(nested.content);
  }
  if (real) stack.delete(real);
  return { path: file.path, content: parts.join("\n") };
}

async function realpathSafe(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export interface SystemPromptOptions {
  cwd: string;
  agent: AgentDefinition;
  toolNames: string[];
  contextFiles?: ContextFile[];
  /** Discovered skills, advertised so the model can self-select them. */
  skills?: SkillDefinition[];
}

export interface SystemPromptBuildResult extends SystemPromptSections {
  /** Full joined system prompt for messages[0].content. */
  content: string;
}

/** Assemble structured system-prompt parts for context accounting + the wire string. */
export function buildSystemPromptParts(opts: SystemPromptOptions): SystemPromptBuildResult {
  const systemParts: string[] = [];

  systemParts.push(
    "You are Deyin, an autonomous software engineering agent running in the user's terminal. You accomplish tasks by calling tools; you never pretend to have taken an action without the corresponding tool call.",
  );

  systemParts.push(opts.agent.prompt);

  systemParts.push(
    [
      "# Environment",
      `- Working directory: ${opts.cwd}`,
      `- Platform: ${platform()}`,
      `- Shell: ${effectiveShell(opts.cwd)} (the bash tool runs commands through this shell)`,
      `- Date: ${new Date().toDateString()}`,
    ].join("\n"),
  );

  systemParts.push(
    [
      "# Tool rules",
      `- Available tools: ${opts.toolNames.join(", ")}.`,
      "- You can use multiple tools in one response when they are independent. Prefer batching over serial text→one-tool→text turns — each turn re-sends the full context.",
      "- Do not narrate or probe with one shell command per turn when you can combine checks (`cmd1 && cmd2`) or issue several tool calls together.",
      "- Reserve a new turn for work that truly depends on a prior tool result.",
      "- Think through the whole change before the first edit: read the relevant code, understand the surrounding context and its edge cases, and plan the full edit path. Editing before you understand the scope costs more tool calls than the reading would have.",
      "- Read files before editing them; edits must match the file content exactly.",
      "- When one file needs several changes, send them as a single edit call with the edits array rather than one call per change, and use replace_all for a rename that applies throughout.",
      "- Prefer edit over write for existing files; never truncate a file to avoid rewriting it.",
      "- Use bash for builds, tests and git. Commands run non-interactively; avoid anything that waits for input.",
      "- For multi-step tasks, maintain a todo list with todo_write and keep it current.",
      "- When you are done, reply with a concise summary of what you did. Do not end your reply with a question unless you are genuinely blocked.",
    ].join("\n"),
  );

  const system = systemParts.join("\n\n");
  const skills = skillsPromptSection(opts.skills ?? []) ?? "";

  const ruleParts: string[] = [];
  for (const file of opts.contextFiles ?? []) {
    ruleParts.push(`# Instructions from ${file.path}\n${file.content}`);
  }
  const rules = ruleParts.join("\n\n");

  const content = [system, skills, rules].filter((s) => s.length > 0).join("\n\n");
  return { system, skills, rules, content };
}

/** Append sessionStart hook context into the rules bucket (and the joined content). */
export function appendHookContext(parts: SystemPromptBuildResult, hookLines: string[]): SystemPromptBuildResult {
  if (hookLines.length === 0) return parts;
  const block = `# Hook context\n${hookLines.join("\n")}`;
  const rules = parts.rules.length > 0 ? `${parts.rules}\n\n${block}` : block;
  const content = parts.content.length > 0 ? `${parts.content}\n\n${block}` : block;
  return { ...parts, rules, content };
}

/** Assemble the system prompt: identity, agent mode, environment, tool rules, skills, project context. */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  return buildSystemPromptParts(opts).content;
}
