/**
 * Minimal YAML frontmatter parser for capability definition files (SKILL.md,
 * subagent .md, command .md). Supports the flat subset those files use:
 * strings (bare or quoted), booleans, numbers and [a, b] / comma lists.
 * Anything more exotic stays a raw string — never throws.
 */

export interface Frontmatter {
  data: Record<string, string | number | boolean | string[]>;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(source: string): Frontmatter {
  const match = FENCE.exec(source);
  if (!match) return { data: {}, body: source };

  const data: Frontmatter["data"] = {};
  for (const rawLine of match[1]!.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (!key) continue;
    data[key] = parseValue(rawValue);
  }
  return { data, body: source.slice(match[0].length) };
}

function parseValue(raw: string): string | number | boolean | string[] {
  if (raw === "") return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // [a, b, c] inline lists
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((part) => unquote(part.trim()))
      .filter(Boolean);
  }
  return unquote(raw);
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Frontmatter field as string, with a fallback. */
export function fmString(data: Frontmatter["data"], key: string): string | undefined {
  const value = data[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

export function fmBool(data: Frontmatter["data"], key: string): boolean | undefined {
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Frontmatter field as a positive finite number, with a fallback. */
export function fmNumber(data: Frontmatter["data"], key: string): number | undefined {
  const value = data[key];
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Frontmatter field as a reasoning-effort level ("low" | "medium" | "high"). */
export function fmEffort(data: Frontmatter["data"], key = "effort"): "low" | "medium" | "high" | undefined {
  const value = fmString(data, key)?.toLowerCase();
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

/** Frontmatter field as a list of non-empty strings (`[a, b]` or comma-separated). */
export function fmStringList(data: Frontmatter["data"], key: string): string[] | undefined {
  const value = data[key];
  const parts: string[] = [];
  if (Array.isArray(value)) {
    parts.push(...value.filter((v): v is string => typeof v === "string" && v.trim() !== ""));
  } else if (typeof value === "string" && value.includes(",")) {
    parts.push(...value.split(","));
  } else if (typeof value === "string" && value.trim() !== "") {
    parts.push(value);
  }
  const out = parts.map((p) => p.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}
