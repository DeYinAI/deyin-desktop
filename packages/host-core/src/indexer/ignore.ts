import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ignore rules for the workspace index: built-in defaults plus simple
 * .gitignore / .deyinignore patterns (name, dir/, *.ext, path prefixes,
 * ** wildcards). Negations are not supported — indexing errs on skipping.
 */

const ALWAYS_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
]);

const ALWAYS_IGNORED_FILES = [/^\.env/, /\.lock$/, /-lock\.(json|yaml)$/, /\.min\.(js|css)$/, /\.(map|log)$/];

interface Rule {
  regex: RegExp;
  dirOnly: boolean;
}

function patternToRegex(pattern: string): RegExp | null {
  let p = pattern.trim();
  if (!p || p.startsWith("#") || p.startsWith("!")) return null;
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0001")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\u0001", ".*");
  // Unanchored patterns match at any depth.
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${escaped}(?:/.*)?$`);
}

export class IgnoreMatcher {
  private rules: Rule[] = [];

  constructor(root: string) {
    for (const file of [".gitignore", ".deyinignore"]) {
      let raw: string;
      try {
        raw = readFileSync(join(root, file), "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split(/\r?\n/)) {
        const dirOnly = line.trim().endsWith("/");
        const regex = patternToRegex(dirOnly ? line.trim().slice(0, -1) : line);
        if (regex) this.rules.push({ regex, dirOnly });
      }
    }
  }

  /** `rel` uses forward slashes, relative to the workspace root. */
  ignored(rel: string, isDir: boolean): boolean {
    const name = rel.split("/").pop() ?? rel;
    if (isDir && (ALWAYS_IGNORED_DIRS.has(name) || name.startsWith("."))) return true;
    if (!isDir && ALWAYS_IGNORED_FILES.some((r) => r.test(name))) return true;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) {
        // Directory rules also swallow everything inside; caller prunes dirs first.
        if (rule.regex.test(rel)) return true;
        continue;
      }
      if (rule.regex.test(rel)) return true;
    }
    return false;
  }
}
