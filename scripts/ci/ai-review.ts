#!/usr/bin/env node
/**
 * Openference AI code review for pull requests.
 * Runs Bugbot + Security Review with structured JSON output and posts a PR comment.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUGBOT_CI_PROMPT,
  FINDINGS_JSON_SCHEMA,
  SECURITY_REVIEW_CI_PROMPT,
} from "../../packages/agent-core/src/review-contracts.ts";

const COMMENT_MARKER = "<!-- deyin-ai-review -->";
const MAX_DIFF_BYTES = 100 * 1024;
const API_BASE = process.env.OPENFERENCE_API_BASE ?? "https://api.openference.com/v1";
const MODEL = process.env.OPENFERENCE_REVIEW_MODEL?.trim() || "GLM-5.2";
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const SEVERITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

const apiKey = process.env.OPENFERENCE_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const baseRef = process.env.BASE_REF ?? "main";
const repoPath = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fail(message: string): never {
  console.error(message);
  throw new Error(message);
}

function requireEnv(): void {
  if (!apiKey) fail("OPENFERENCE_API_KEY is required");
  if (!githubToken) fail("GITHUB_TOKEN is required");
  if (!repo) fail("GITHUB_REPOSITORY is required");
  if (!prNumber) fail("PR_NUMBER is required");
}

function gitDiff(): { diff: string; stat: string; truncated: boolean } {
  run(`git fetch origin ${baseRef} --depth=1`);
  const mergeBase = run(`git merge-base HEAD origin/${baseRef}`);
  const stat = run(`git diff --stat ${mergeBase}`);
  let diff = run(`git diff ${mergeBase}`);
  let truncated = false;
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES);
    truncated = true;
  }
  return { diff, stat, truncated };
}

interface Finding {
  severity: "Critical" | "High" | "Medium" | "Low";
  location: string;
  finding: string;
  reviewer: "bugbot" | "security";
}

interface ReviewResult {
  findings: Finding[];
  review_notes: string;
}

async function callReviewer(
  systemPrompt: string,
  reviewer: "bugbot" | "security",
  userContent: string,
): Promise<ReviewResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "code_review_findings",
            strict: true,
            schema: FINDINGS_JSON_SCHEMA,
          },
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      fail(`Openference API error (${reviewer}): ${res.status} ${body}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) fail(`Openference API returned empty content (${reviewer})`);

    let parsed: ReviewResult;
    try {
      const raw = JSON.parse(content) as Partial<ReviewResult>;
      parsed = {
        findings: Array.isArray(raw.findings) ? raw.findings : [],
        review_notes: typeof raw.review_notes === "string" ? raw.review_notes : "",
      };
    } catch {
      fail(`Openference API returned invalid JSON (${reviewer}): ${content.slice(0, 500)}`);
    }

    for (const f of parsed.findings) {
      f.reviewer = reviewer;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function buildUserPrompt(diff: string, stat: string, truncated: boolean): string {
  const truncationNote = truncated
    ? "\n\nNote: diff was truncated to 100KB for CI. Review what is present and note uncovered files in review_notes if needed."
    : "";
  return `Full Repository Path: ${repoPath}
Diff: branch changes
Base Branch: ${baseRef}

Diff stat:
${stat}

Diff:
${diff}${truncationNote}`;
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99),
  );
}

function renderComment(findings: Finding[], notes: string[], truncated: boolean): string {
  const lines = [COMMENT_MARKER, "## Deyin AI review (Bugbot + Security)", ""];

  if (truncated) {
    lines.push(
      "> Diff exceeded 100KB and was truncated. Manual review recommended for uncovered files.",
      "",
    );
  }

  if (findings.length === 0) {
    lines.push("No issues found.");
  } else {
    lines.push("| Severity | Location | Reviewer | Finding |");
    lines.push("| --- | --- | --- | --- |");
    for (const f of findings) {
      const finding = f.finding.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${f.severity} | ${f.location} | ${f.reviewer} | ${finding} |`);
    }
  }

  const noteBlock = notes.filter(Boolean).join("\n");
  if (noteBlock) {
    lines.push("", "**Review notes**", "", noteBlock);
  }

  lines.push("", "_Automated review via Openference. Critical/High findings fail this check._");
  return lines.join("\n");
}

function renderErrorComment(message: string): string {
  return [
    COMMENT_MARKER,
    "## Deyin AI review (Bugbot + Security)",
    "",
    "AI review failed before results could be posted.",
    "",
    "```",
    message,
    "```",
    "",
    "_Check the workflow logs for full details. Override model with the `OPENFERENCE_REVIEW_MODEL` env var._",
  ].join("\n");
}

async function ghApi(path: string, method = "GET", body?: unknown): Promise<unknown> {
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
    fail(`GitHub API error ${method} ${path}: ${res.status} ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function upsertComment(body: string): Promise<void> {
  const [owner, name] = repo!.split("/");
  const comments = (await ghApi(
    `/repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`,
  )) as Array<{ id: number; body?: string }>;

  const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
  if (existing) {
    await ghApi(`/repos/${owner}/${name}/issues/comments/${existing.id}`, "PATCH", { body });
    console.log(`Updated PR comment ${existing.id}`);
  } else {
    await ghApi(`/repos/${owner}/${name}/issues/${prNumber}/comments`, "POST", { body });
    console.log("Created PR comment");
  }
}

function hasBlockingFindings(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "Critical" || f.severity === "High");
}

async function main(): Promise<void> {
  requireEnv();

  if (!existsSync(resolve(repoPath, ".git"))) {
    fail("Not a git repository");
  }

  const { diff, stat, truncated } = gitDiff();

  if (!diff.trim()) {
    const body = renderComment([], ["No diff to review."], false);
    await upsertComment(body);
    console.log("Empty diff — skipping API review");
    return;
  }

  const userPrompt = buildUserPrompt(diff, stat, truncated);

  console.log("Running Bugbot review...");
  const bugbot = await callReviewer(BUGBOT_CI_PROMPT, "bugbot", userPrompt);

  console.log("Running Security review...");
  const security = await callReviewer(SECURITY_REVIEW_CI_PROMPT, "security", userPrompt);

  const findings = sortFindings([...bugbot.findings, ...security.findings]);
  const notes = [bugbot.review_notes, security.review_notes].filter(Boolean);

  const comment = renderComment(findings, notes, truncated);
  await upsertComment(comment);

  console.log(`Findings: ${findings.length} (${findings.filter((f) => f.severity === "Critical" || f.severity === "High").length} blocking)`);

  if (hasBlockingFindings(findings)) {
    fail("AI review found Critical or High severity issues — see PR comment");
  }
}

main().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  try {
    if (githubToken && repo && prNumber) {
      await upsertComment(renderErrorComment(message));
    }
  } catch (commentErr) {
    console.error("Failed to post error comment:", commentErr);
  }
  process.exit(1);
});
