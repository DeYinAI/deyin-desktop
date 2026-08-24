import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const COMMENT_MARKER = "<!-- deyin-ai-review -->";
export const FIXES_MARKER_PREFIX = "<!-- deyin-ai-review-fixes:v1:";
const MAX_FIXES_PAYLOAD_BYTES = 256 * 1024;

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

interface FileText {
  lines: string[];
  eol: "\n" | "\r\n";
}

function readFileText(filePath: string): FileText {
  const raw = readFileSync(filePath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && (raw.endsWith("\n") || raw.endsWith("\r\n"))) {
    lines.pop();
  }
  return { lines, eol };
}

function writeFileText(filePath: string, lines: string[], eol: "\n" | "\r\n"): void {
  const trailingNewline = lines.length > 0 ? eol : "";
  writeFileSync(filePath, lines.join(eol) + trailingNewline);
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
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
  const encoded = Buffer.from(JSON.stringify(fixes), "utf8").toString("base64");
  if (encoded.length > MAX_FIXES_PAYLOAD_BYTES) return "";
  return `${FIXES_MARKER_PREFIX}${encoded} -->`;
}

export function decodeFixesPayload(body: string): StoredFix[] {
  const start = body.indexOf(FIXES_MARKER_PREFIX);
  if (start < 0) return [];
  const end = body.indexOf(" -->", start);
  if (end < 0) return [];
  const encoded = body.slice(start + FIXES_MARKER_PREFIX.length, end);
  if (encoded.length > MAX_FIXES_PAYLOAD_BYTES) return [];
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
    fix.path.length > 0 &&
    fix.path.length <= 512 &&
    typeof fix.start_line === "number" &&
    typeof fix.end_line === "number" &&
    typeof fix.replacement === "string" &&
    fix.replacement.length <= 64 * 1024 &&
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
  let file: FileText;
  try {
    file = readFileText(filePath);
  } catch {
    return `file not found: ${fix.path}`;
  }
  if (fix.start_line < 1 || fix.end_line > file.lines.length || fix.end_line < fix.start_line) {
    return `line range out of bounds for ${fix.path}: ${fix.start_line}-${fix.end_line}`;
  }
  return null;
}

export function applySuggestedFix(repoPath: string, fix: SuggestedFix): void {
  const error = validateSuggestedFix(repoPath, fix);
  if (error) throw new Error(error);
  const root = resolve(repoPath);
  const filePath = resolve(root, fix.path);
  const file = readFileText(filePath);
  const replacementLines = fix.replacement.split(/\r?\n/);
  const next = [
    ...file.lines.slice(0, fix.start_line - 1),
    ...replacementLines,
    ...file.lines.slice(fix.end_line),
  ];
  writeFileText(filePath, next, file.eol);
}

export function fixesOverlap(a: SuggestedFix, b: SuggestedFix): boolean {
  if (a.path !== b.path) return false;
  return a.start_line <= b.end_line && b.start_line <= a.end_line;
}

export function sortFixesForApply(fixes: StoredFix[]): StoredFix[] {
  return [...fixes].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return b.start_line - a.start_line;
  });
}

export function suggestionCommentBody(finding: ReviewFinding, repoPath: string): string | null {
  const fix = finding.suggested_fix;
  if (!fix) return null;

  const validationError = validateSuggestedFix(repoPath, fix);
  if (validationError) return null;

  const root = resolve(repoPath);
  const file = readFileText(resolve(root, fix.path));
  const endLine = fix.end_line;
  if (fix.start_line < 1 || endLine > file.lines.length || endLine < fix.start_line) return null;
  if (!fix.replacement) return null;

  const summary = escapeMarkdownCell(finding.finding);
  return [
    `**${finding.severity}** (${finding.reviewer}) — ${summary}`,
    "",
    "```suggestion",
    fix.replacement,
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

  const root = resolve(repoPath);
  const file = readFileText(resolve(root, fix.path));
  const endLine = Math.min(fix.end_line, file.lines.length);
  if (fix.start_line < 1 || endLine < fix.start_line) return null;

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
