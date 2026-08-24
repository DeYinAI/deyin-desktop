#!/usr/bin/env node
/**
 * Apply AI review suggested fixes to a PR branch after maintainer approval.
 * Triggered when someone comments `/ai-fix apply` on the pull request.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  applySuggestedFix,
  decodeFixesPayload,
  fixesOverlap,
  ghApi,
  COMMENT_MARKER,
  sortFixesForApply,
  type StoredFix,
} from "./ai-review-shared.ts";

const githubToken = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const repoPath = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());

function runGit(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fail(message: string): never {
  console.error(message);
  throw new Error(message);
}

async function loadFixesFromReviewComment(owner: string, name: string): Promise<StoredFix[]> {
  const comments = (await ghApi(
    githubToken!,
    `/repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`,
  )) as Array<{ body?: string }>;
  const reviewComment = comments.find((c) => c.body?.includes(COMMENT_MARKER));
  if (!reviewComment?.body) fail("No AI review comment found on this PR");
  const fixes = decodeFixesPayload(reviewComment.body);
  if (fixes.length === 0) fail("AI review comment has no suggested fixes to apply");
  return fixes;
}

function resolveHeadRef(rawRef: string): string {
  const sanitized = rawRef.replace(/[^A-Za-z0-9._/-]/g, "");
  if (!sanitized || sanitized !== rawRef) {
    fail(`Invalid PR head ref: ${rawRef}`);
  }
  return sanitized;
}

async function main(): Promise<void> {
  if (!githubToken) fail("GITHUB_TOKEN is required");
  if (!repo) fail("GITHUB_REPOSITORY is required");
  if (!prNumber) fail("PR_NUMBER is required");
  if (!existsSync(resolve(repoPath, ".git"))) fail("Not a git repository");

  const [owner, name] = repo.split("/");
  const pr = (await ghApi(githubToken, `/repos/${owner}/${name}/pulls/${prNumber}`)) as {
    head: { ref: string; sha: string };
  };

  const fixes = sortFixesForApply(await loadFixesFromReviewComment(owner, name));
  console.log(`Applying ${fixes.length} suggested fix(es)...`);

  const applied: StoredFix[] = [];
  for (const fix of fixes) {
    if (applied.some((prev) => fixesOverlap(prev, fix))) {
      console.warn(`  skip overlapping fix ${fix.path}:${fix.start_line}-${fix.end_line}`);
      continue;
    }
    applySuggestedFix(repoPath, fix);
    applied.push(fix);
    console.log(`  applied ${fix.path}:${fix.start_line}-${fix.end_line}`);
  }

  if (applied.length === 0) {
    fail("No fixes applied — all overlapped or invalid");
  }

  runGit(["add", "-A"]);
  const status = runGit(["status", "--porcelain"]);
  if (!status.trim()) {
    console.log("No file changes after applying fixes — nothing to commit");
    return;
  }

  const message = `fix: apply AI review suggestions (${applied.length} patch(es))`;
  runGit(["commit", "-m", message]);
  const headRef = resolveHeadRef(pr.head.ref);
  runGit(["push", "origin", `HEAD:${headRef}`]);
  console.log(`Pushed fixes to ${headRef}`);

  await ghApi(githubToken, `/repos/${owner}/${name}/issues/${prNumber}/comments`, "POST", {
    body: [
      "<!-- deyin-ai-review-applied -->",
      "## AI review fixes applied",
      "",
      `Committed ${applied.length} suggested patch(es) to \`${pr.head.ref}\`.`,
      "",
      "Re-run CI to verify. The `ai-review` check will refresh on the next push.",
    ].join("\n"),
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
