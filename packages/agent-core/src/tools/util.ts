import { isAbsolute, relative, resolve } from "node:path";

/** Cap tool output so one command cannot blow the context window. */
export const MAX_TOOL_OUTPUT = 30_000;

export function truncate(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [output truncated: ${text.length - max} more characters]`;
}

/** Resolve a tool path argument against the run's cwd. */
export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Resolve a path and reject escapes outside the workspace root (cwd). */
export function resolvePathInWorkspace(cwd: string, path: string): string {
  const resolved = resolvePath(cwd, path);
  const root = resolve(cwd);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return resolved;
}

export function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string parameter "${name}".`);
  }
  return value;
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Missing required string array parameter "${name}".`);
  }
  return value.map((v, i) => {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`Invalid string at "${name}[${i}]".`);
    }
    return v;
  });
}

/** Directories never walked by grep/glob/ls fallbacks. */
export const IGNORED_DIRS = new Set([".git", "node_modules", ".DS_Store", "dist", "out", ".cache", ".next", "coverage"]);
