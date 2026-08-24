#!/usr/bin/env node
/**
 * Openference AI code review for pull requests.
 * Runs Bugbot + Security Review, posts findings, and attaches GitHub suggested fixes.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUGBOT_CI_PROMPT,
  FINDINGS_WITH_FIXES_JSON_SCHEMA,
  SECURITY_REVIEW_CI_PROMPT,
} from "../../packages/agent-core/src/review-contracts.ts";
import {
  COMMENT_MARKER,
  githubReviewCommentForFix,
  encodeFixesPayload,
  ghApi,
  validateSuggestedFix,
  type ReviewFinding,
  type SuggestedFix,
} from "./ai-review-shared.ts";

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
const headSha = process.env.PR_HEAD_SHA;
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

interface ReviewResult {
  findings: ReviewFinding[];
  review_notes: string;
}

function normalizeFinding(raw: Partial<ReviewFinding>, reviewer: ReviewFinding["reviewer"]): ReviewFinding {
  const suggestedFix = normalizeSuggestedFix(raw.suggested_fix);
  return {
    severity: raw.severity ?? "Low",
    location: raw.location ?? "unknown",
    finding: raw.finding ?? "",
    reviewer,
    suggested_fix: suggestedFix,
  };
}

function normalizeSuggestedFix(value: unknown): SuggestedFix | null {
  if (!value || typeof value !== "object") return null;
  const fix = value as Partial<SuggestedFix>;
  if (
    typeof fix.path !== "string" ||
    typeof fix.start_line !== "number" ||
    typeof fix.end_line !== "number" ||
    typeof fix.replacement !== "string"
  ) {
    return null;
  }
  return {
    path: fix.path,
    start_line: fix.start_line,
    end_line: fix.end_line,
    replacement: fix.replacement,
  };
}

async function callReviewer(
  systemPrompt: string,
  reviewer: ReviewFinding["reviewer"],
  userContent: string,
): Promise<ReviewResult> {
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= 2; attempt++) {
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
            {
              role: "user",
              content:
                attempt === 1
                  ? userContent
                  : `${userContent}\n\nReturn ONLY valid JSON matching the schema. No prose, markdown, or explanation outside the JSON object.`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "code_review_findings",
              strict: true,
              schema: FINDINGS_WITH_FIXES_JSON_SCHEMA,
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
      if (!content) {
        lastError = `empty content (${reviewer})`;
        continue;
      }

      const parsed = parseReviewJson(content, reviewer);
      return parsed;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    if (attempt === 1) {
      console.warn(`Retrying ${reviewer} review after: ${lastError}`);
    }
  }

  console.warn(`${reviewer} review unavailable after retries: ${lastError}`);
  return {
    findings: [],
    review_notes: `${reviewer} review failed to return structured JSON: ${lastError}`,
  };
}

function parseReviewJson(content: string, reviewer: ReviewFinding["reviewer"]): ReviewResult {
  const candidates = [content.trim()];
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const objectMatch = content.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(candidate) as {
        findings?: Partial<ReviewFinding>[];
        review_notes?: string;
      };
      return {
        findings: Array.isArray(raw.findings)
          ? raw.findings.map((f) => normalizeFinding(f, reviewer))
          : [],
        review_notes: typeof raw.review_notes === "string" ? raw.review_notes : "",
      };
    } catch {
      continue;
    }
  }

  throw new Error(`invalid JSON (${reviewer}): ${content.slice(0, 500)}`);
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

function sortFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99),
  );
}

function renderComment(findings: ReviewFinding[], notes: string[], truncated: boolean): string {
  const fixable = findings.filter((f) => f.suggested_fix).length;
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
    lines.push("| Severity | Location | Reviewer | Finding | Fix |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const f of findings) {
      const finding = f.finding.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
      const fixCell = f.suggested_fix ? "Suggested below" : "Manual";
      lines.push(`| ${f.severity} | ${f.location} | ${f.reviewer} | ${finding} | ${fixCell} |`);
    }
  }

  const noteBlock = notes.filter(Boolean).join("\n");
  if (noteBlock) {
    lines.push("", "**Review notes**", "", noteBlock);
  }

  if (fixable > 0) {
    lines.push(
      "",
      "### Apply fixes",
      "",
      `- **Per fix:** open the **Files changed** tab — inline comments include **Commit suggestion** buttons.`,
      `- **All fixes:** comment \`/ai-fix apply\` on this PR to commit every suggested patch to the branch.`,
      "",
      `${fixable} suggested fix(es) attached.`,
    );
  }

  const fixesPayload = encodeFixesPayload(findings);
  if (fixesPayload) lines.push("", fixesPayload);

  lines.push("", "_Automated review via Openference. Critical findings fail this check._");
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

async function upsertComment(body: string): Promise<void> {
  const [owner, name] = repo!.split("/");
  const comments = (await ghApi(
    githubToken!,
    `/repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`,
  )) as Array<{ id: number; body?: string }>;

  const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
  if (existing) {
    await ghApi(githubToken!, `/repos/${owner}/${name}/issues/comments/${existing.id}`, "PATCH", { body });
    console.log(`Updated PR comment ${existing.id}`);
  } else {
    await ghApi(githubToken!, `/repos/${owner}/${name}/issues/${prNumber}/comments`, "POST", { body });
    console.log("Created PR comment");
  }
}

async function resolveHeadSha(owner: string, name: string): Promise<string> {
  if (headSha) return headSha;
  const pr = (await ghApi(githubToken!, `/repos/${owner}/${name}/pulls/${prNumber}`)) as {
    head: { sha: string };
  };
  return pr.head.sha;
}

async function postSuggestedFixComments(findings: ReviewFinding[], commitId: string): Promise<number> {
  const [owner, name] = repo!.split("/");
  const comments: Array<{
    path: string;
    body: string;
    line: number;
    start_line?: number;
  }> = [];

  for (const finding of findings) {
    const comment = githubReviewCommentForFix(finding, repoPath);
    if (!comment) {
      const fix = finding.suggested_fix;
      if (fix) {
        const validationError = validateSuggestedFix(repoPath, fix);
        console.warn(
          `Skipping suggested fix at ${finding.location}: ${validationError ?? "could not build GitHub suggestion"}`,
        );
      }
      continue;
    }
    comments.push({
      path: comment.path,
      line: comment.line,
      ...(comment.start_line < comment.line ? { start_line: comment.start_line } : {}),
      body: comment.body,
    });
  }

  if (comments.length === 0) return 0;

  await ghApi(githubToken!, `/repos/${owner}/${name}/pulls/${prNumber}/reviews`, "POST", {
    commit_id: commitId,
    event: "COMMENT",
    body: "Suggested fixes from Deyin AI review — use **Commit suggestion** to approve each patch.",
    comments,
  });
  console.log(`Posted ${comments.length} suggested fix comment(s)`);
  return comments.length;
}

function hasBlockingFindings(findings: ReviewFinding[]): boolean {
  return findings.some((f) => f.severity === "Critical");
}

class BlockingReviewError extends Error {
  constructor() {
    super("AI review found Critical severity issues — see PR comment and suggested fixes");
    this.name = "BlockingReviewError";
  }
}

async function main(): Promise<void> {
  requireEnv();

  if (!existsSync(resolve(repoPath, ".git"))) {
    fail("Not a git repository");
  }

  const [owner, name] = repo!.split("/");
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

  const commitId = await resolveHeadSha(owner, name);
  await postSuggestedFixComments(findings, commitId);

  const comment = renderComment(findings, notes, truncated);
  await upsertComment(comment);

  console.log(`Findings: ${findings.length} (${findings.filter((f) => f.severity === "Critical" || f.severity === "High").length} blocking)`);

  if (hasBlockingFindings(findings)) {
    throw new BlockingReviewError();
  }
}

main().catch(async (err: unknown) => {
  if (err instanceof BlockingReviewError) {
    console.error(err.message);
    process.exit(1);
  }

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
