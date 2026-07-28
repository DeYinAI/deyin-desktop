import { readFile, readdir } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import type { AgentDefinition } from "./agents.js";

const MAX_CONTEXT_FILE_CHARS = 20_000;
const MAX_PARENT_LEVELS = 5;

export interface ContextFile {
  path: string;
  content: string;
}

/**
 * Load project instructions: AGENTS.md from cwd up to MAX_PARENT_LEVELS ancestors
 * (nearest last so it wins), plus every markdown file in <cwd>/.deyin/rules/.
 */
export async function loadContextFiles(cwd: string): Promise<ContextFile[]> {
  const files: ContextFile[] = [];

  const dirs: string[] = [];
  let dir = cwd;
  for (let i = 0; i < MAX_PARENT_LEVELS; i++) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Farthest ancestor first, so the nearest AGENTS.md appears last (highest priority).
  for (const d of dirs.reverse()) {
    const path = join(d, "AGENTS.md");
    const content = await readOptional(path);
    if (content) files.push({ path, content: content.slice(0, MAX_CONTEXT_FILE_CHARS) });
  }

  try {
    const rulesDir = join(cwd, ".deyin", "rules");
    const entries = await readdir(rulesDir, { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(rulesDir, entry.name);
      const content = await readOptional(path);
      if (content) files.push({ path, content: content.slice(0, MAX_CONTEXT_FILE_CHARS) });
    }
  } catch {
    // no rules dir
  }

  return files;
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
}

/** Assemble the system prompt: identity, agent mode, environment, tool rules, project context. */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const sections: string[] = [];

  sections.push(
    "You are Deyin, an autonomous software engineering agent running in the user's terminal. You accomplish tasks by calling tools; you never pretend to have taken an action without the corresponding tool call.",
  );

  sections.push(opts.agent.prompt);

  sections.push(
    [
      "# Environment",
      `- Working directory: ${opts.cwd}`,
      `- Platform: ${platform()}`,
      `- Date: ${new Date().toDateString()}`,
    ].join("\n"),
  );

  sections.push(
    [
      "# Tool rules",
      `- Available tools: ${opts.toolNames.join(", ")}.`,
      "- Read files before editing them; edits must match the file content exactly.",
      "- Prefer edit over write for existing files; never truncate a file to avoid rewriting it.",
      "- Use bash for builds, tests and git. Commands run non-interactively; avoid anything that waits for input.",
      "- For multi-step tasks, maintain a todo list with todo_write and keep it current.",
      "- When you are done, reply with a concise summary of what you did. Do not end your reply with a question unless you are genuinely blocked.",
    ].join("\n"),
  );

  for (const file of opts.contextFiles ?? []) {
    sections.push(`# Project instructions from ${file.path}\n${file.content}`);
  }

  return sections.join("\n\n");
}
