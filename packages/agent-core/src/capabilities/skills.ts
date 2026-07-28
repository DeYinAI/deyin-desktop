import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fmBool, fmString, parseFrontmatter } from "./frontmatter.js";
import type { CapabilityRoot } from "./paths.js";

export interface SkillDefinition {
  /** Kebab-case skill name (frontmatter `name`, else the folder name). */
  name: string;
  description: string;
  /** Absolute path of the SKILL.md file — the agent reads it on use. */
  path: string;
  /** "workspace" | "user" | "plugin:<name>" | "built-in" */
  source: string;
  /** Only invocable via /name — never auto-selected by the model. */
  disableModelInvocation: boolean;
}

const MAX_DEPTH = 4;

/**
 * Discover skills: any SKILL.md under the given roots (recursively, category
 * folders allowed). First definition of a name wins, so pass roots in
 * precedence order (workspace before user before plugins).
 */
export async function discoverSkills(roots: CapabilityRoot[]): Promise<SkillDefinition[]> {
  const byName = new Map<string, SkillDefinition>();
  for (const root of roots) {
    for (const file of await findSkillFiles(root.dir, 0)) {
      const skill = await loadSkill(file, root.source);
      if (skill && !byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}

async function findSkillFiles(dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "SKILL.md") files.push(join(dir, entry.name));
    else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      files.push(...(await findSkillFiles(join(dir, entry.name), depth + 1)));
    }
  }
  return files;
}

export async function loadSkill(path: string, source: string): Promise<SkillDefinition | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const folder = basename(dirname(path));
  const name = (fmString(data, "name") ?? folder).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const description = fmString(data, "description") ?? firstLine(body) ?? name;
  if (!name) return null;
  return {
    name,
    description,
    path,
    source,
    disableModelInvocation: fmBool(data, "disable-model-invocation") ?? false,
  };
}

function firstLine(body: string): string | undefined {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
}

/** Prompt section advertising available skills to the model. */
export function skillsPromptSection(skills: SkillDefinition[]): string | null {
  const advertised = skills.filter((s) => !s.disableModelInvocation);
  if (advertised.length === 0) return null;
  return [
    "# Skills",
    "Reusable instructions for specific task types. When a skill matches the task, read its SKILL.md with the read tool and follow it before proceeding.",
    ...advertised.map((s) => `- ${s.name}: ${s.description} (${s.path})`),
  ].join("\n");
}

/** SKILL.md template used by the bundled create-skill flow. */
export function skillTemplate(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDescribe step by step how the agent should perform this task.\n\n## Steps\n\n1. ...\n2. ...\n`;
}
