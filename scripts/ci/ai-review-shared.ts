import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const COMMENT_MARKER = "<!-- deyin-ai-review -->";
export const FIXES_MARKER_PREFIX = "<!-- deyin-ai-review-fixes:v1:";

export interface SuggestedFix {
  path: string;
  start_line: number;
  end_line: number;
  replacement: string;
}

export interface ReviewFinding {
  severity: "Critical" | "High" | "Medium" | "Low";
  location: string;
  finding: string;
  reviewer: "bugbot" | "security";
  suggested_fix?: SuggestedFix | null;
}

export interface StoredFix extends SuggestedFix {
  severity: ReviewFinding["severity"];
  location: string;
  finding: string;
  reviewer: ReviewFinding["reviewer"];
}

export function encodeFixesPayload(findings: ReviewFinding[]): string {
  const fixes: StoredFix[] = findings
    .filter((f): f is ReviewFinding & { suggested_fix: SuggestedFix } => !!f.suggested_fix)
    .map((f) => ({
      ...f.suggested_fix,
      severity: f.severity,
      location: f.location,
      finding: f.finding,
      reviewer: f.reviewer,
    }));
  if (fixes.length === 0) return "";
  return `${FIXES_MARKER_PREFIX}${Buffer.from(JSON.stringify(fixes), "utf8").toString("base64")} -->`;
}

export function decodeFixesPayload(body: string): StoredFix[] {
  const start = body.indexOf(FIXES_MARKER_PREFIX);
  if (start < 0) return [];
  const end = body.indexOf(" -->", start);
  if (end < 0) return [];
  const encoded = body.slice(start + FIXES_MARKER_PREFIX.length, end);
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredFix);
  } catch {
    return [];
  }
}

function isStoredFix(value: unknown): value is StoredFix {
  if (!value || typeof value !== "object") return false;
  const fix = value as Partial<StoredFix>;
  return (
    typeof fix.path === "string" &&
    typeof fix.start_line === "number" &&
    typeof fix.end_line === "number" &&
    typeof fix.replacement === "string" &&
    fix.start_line >= 1 &&
    fix.end_line >= fix.start_line
  );
}

export function validateSuggestedFix(repoPath: string, fix: SuggestedFix): string | null {
  if (!fix.path || fix.path.includes("\0") || fix.path.startsWith("/")) {
    return `invalid path: ${fix.path}`;
  }
  const root = resolve(repoPath);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const filePath = resolve(root, fix.path);
  if (!filePath.startsWith(rootPrefix)) {
    return `invalid path: ${fix.path}`;
  }
  const rel = relative(root, filePath);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) {
    return `invalid path: ${fix.path}`;
  }
  let lines: string[];
  try {
    lines = readFileSync(filePath, "utf8").split("\n");
  } catch {
    return `file not found: ${fix.path}`;
  }
  if (fix.start_line < 1 || fix.end_line > lines.length || fix.end_line < fix.start_line) {
    return `line range out of bounds for ${fix.path}: ${fix.start_line}-${fix.end_line}`;
  }
  return null;
}

export function applySuggestedFix(repoPath: string, fix: SuggestedFix): void {
  const error = validateSuggestedFix(repoPath, fix);
  if (error) throw new Error(error);
  const filePath = resolve(repoPath, fix.path);
  const lines = readFileSync(filePath, "utf8").split("\n");
  const next = [
    ...lines.slice(0, fix.start_line - 1),
    ...fix.replacement.split("\n"),
    ...lines.slice(fix.end_line),
  ];
  writeFileSync(filePath, next.join("\n"));
}

export function suggestionCommentBody(finding: ReviewFinding, repoPath: string): string | null {
  const fix = finding.suggested_fix;
  if (!fix) return null;

  const validationError = validateSuggestedFix(repoPath, fix);
  if (validationError) return null;

  const filePath = resolve(repoPath, fix.path);
  const fileLines = readFileSync(filePath, "utf8").split("\n");
  const endLine = Math.min(fix.end_line, fileLines.length);
  if (fix.start_line < 1 || endLine < fix.start_line) return null;

  // GitHub replaces exactly start_line..line; replacement must be the new text for that span.
  const replacement = fix.replacement.trimEnd();
  if (!replacement) return null;

  const summary = finding.finding.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `**${finding.severity}** (${finding.reviewer}) — ${summary}`,
    "",
    "```suggestion",
    replacement,
    "```",
  ].join("\n");
}

export function githubReviewCommentForFix(
  finding: ReviewFinding,
  repoPath: string,
): { path: string; body: string; line: number; start_line: number } | null {
  const fix = finding.suggested_fix;
  if (!fix) return null;
  const body = suggestionCommentBody(finding, repoPath);
  if (!body) return null;

  const replacementLineCount = fix.replacement.split("\n").length;
  const endLine = fix.start_line + replacementLineCount - 1;
  return {
    path: fix.path,
    body,
    start_line: fix.start_line,
    line: endLine,
  };
}

export async function ghApi(
  githubToken: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${method} ${path}: ${res.status} ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}
