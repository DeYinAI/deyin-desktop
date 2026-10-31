/** Normalizes GitHub issues, pull requests, comments and reviews into domain Triggers. */
import { key, escapeRegExp, sameName } from "../core/text.js";
import type { ChannelRef, Trigger } from "../core/types.js";

export const SOURCE = "github";

/** GitHub reply address: the issue or PR conversation, or a review thread when `url` points at a discussion comment. */
export const githubChannel = (number: number, url?: string): ChannelRef => ({
  source: SOURCE,
  thread: `github:${number}`,
  address: { number: String(number), ...(url ? { url } : {}) },
});

export const githubPage = (repository: string, number: number, pr = false): string => `https://github.com/${repository}/${pr ? "pull" : "issues"}/${number}`;

/** Parses a web or API URL of an issue, PR or review comment in `repository`; `undefined` for other URLs or repositories. */
export function githubAddress(url: string, repository: string): { number: number; pr: boolean; discussion?: number } | undefined {
  const pattern = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i;
  const match = pattern.exec(url);
  if (!match || !sameName(match[1]!, repository)) return undefined;
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() !== "issues", ...(match[4] ? { discussion: Number(match[4]) } : {}) };
}

export interface GhUser { login: string; type?: string }
/** A comment or review. A review carries `state` and `commit_id`; an inline comment carries file, line, hunk and `in_reply_to_id`. */
export interface GhComment {
  id: number;
  body?: string | null;
  user: GhUser;
  html_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  submitted_at?: string | null;
  state?: string | null;
  commit_id?: string | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string | null;
  in_reply_to_id?: number | null;
}
export interface GhIssue extends GhComment {
  number: number;
  title: string;
  state: string;
  created_at: string;
  html_url: string;
  pull_request?: { url: string; merged_at?: string | null } | null;
  assignees?: GhUser[] | null;
}
export interface PullRef { number: number; isPr: boolean; url?: string; prAuthor?: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** GitHub returns a deleted account as `null` and displays it as `ghost`. */
function user(value: unknown): GhUser {
  if (!isRecord(value) || typeof value.login !== "string") return { login: "ghost", type: "User" };
  return { login: value.login, ...(typeof value.type === "string" ? { type: value.type } : {}) };
}

const optionalString = (value: unknown): string | null | undefined => (typeof value === "string" ? value : value === null ? null : undefined);
const optionalNumber = (value: unknown): number | null | undefined => (typeof value === "number" ? value : value === null ? null : undefined);

/** @throws when `raw` is not a comment-shaped object, so malformed API data fails loudly instead of producing odd triggers. */
export function parseComment(raw: unknown): GhComment {
  if (!isRecord(raw) || typeof raw.id !== "number") throw new Error("Malformed GitHub comment");
  return {
    id: raw.id,
    body: optionalString(raw.body),
    user: user(raw.user),
    html_url: optionalString(raw.html_url),
    created_at: optionalString(raw.created_at),
    updated_at: optionalString(raw.updated_at),
    submitted_at: optionalString(raw.submitted_at),
    state: optionalString(raw.state),
    commit_id: optionalString(raw.commit_id),
    path: optionalString(raw.path),
    line: optionalNumber(raw.line),
    original_line: optionalNumber(raw.original_line),
    diff_hunk: optionalString(raw.diff_hunk),
    in_reply_to_id: optionalNumber(raw.in_reply_to_id),
  };
}

export function parseIssue(raw: unknown): GhIssue {
  const comment = parseComment(raw);
  const record = raw as Record<string, unknown>;
  if (typeof record.number !== "number" || typeof record.title !== "string" || typeof record.state !== "string" || typeof record.created_at !== "string" || typeof record.html_url !== "string") {
    throw new Error("Malformed GitHub issue");
  }
  const pull = record.pull_request;
  return {
    ...comment,
    number: record.number,
    title: record.title,
    state: record.state,
    created_at: record.created_at,
    html_url: record.html_url,
    pull_request: isRecord(pull) && typeof pull.url === "string" ? { url: pull.url, merged_at: typeof pull.merged_at === "string" ? pull.merged_at : null } : null,
    assignees: Array.isArray(record.assignees) ? record.assignees.map(user) : null,
  };
}

/** True for a regular account rather than a bot or GitHub App; the prompts say which accounts are automated. */
export const isHumanLogin = (account: GhUser): boolean => !/\[bot\]$/.test(account.login) && (!account.type || account.type === "User");

export function reviewPlace(comment: GhComment): string {
  const line = comment.line ?? comment.original_line;
  const hunk = (comment.diff_hunk ?? "").split("\n").slice(-3).join("\n");
  return [`${comment.path}${line != null ? `:${line}` : ""}`, hunk].filter(Boolean).join("\n");
}

function commentText(comment: GhComment, kind: "conversation" | "inline" | "review"): string {
  const decided = kind === "review" && comment.state && comment.state !== "COMMENTED";
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? "unknown"}` : "";
  const place = kind === "inline" && comment.path ? reviewPlace(comment) : "";
  return [decision, place, comment.body ?? ""].filter(Boolean).join("\n\n");
}

export const mentions = (text: string, login: string): boolean => new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, "i").test(text);

const author = (account: GhUser, agent: string) => ({ actor: { source: SOURCE, id: account.login }, human: isHumanLogin(account) && !sameName(account.login, agent) });

/** Marker the agent's own comments carry; the source never turns them back into triggers. */
export const MARKER = "<!-- deyin-superagent:";

export function commentTrigger(comment: GhComment, ref: PullRef, kind: "conversation" | "inline" | "review", agent: string, at: Date = new Date()): Trigger {
  const stamp = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? at.toISOString();
  const version = comment.updated_at ?? comment.submitted_at ?? "";
  const id = key("github-comment", comment.html_url ?? `github:${ref.number}`, String(comment.id), version);
  const place = comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {};
  return {
    id, source: SOURCE, threads: [{ source: SOURCE, id: String(ref.number) }], ...author(comment.user, agent), at: stamp,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? "", agent) ? { addressed: "mention" as const } : {}),
    channel: githubChannel(ref.number, comment.html_url ?? undefined),
    ...((comment.html_url ?? ref.url) ? { url: (comment.html_url ?? ref.url)! } : {}),
    meta: {
      number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind, ...place,
      ...(comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {}),
    },
  };
}

type Opened = Pick<GhIssue, "number" | "title" | "body" | "user" | "created_at" | "html_url"> & { assignees?: GhUser[] | null };

/** The trigger of a newly opened issue's title and body; assigning it to the agent addresses it as a mention does. */
export function issueTrigger(issue: Opened, agent: string): Trigger {
  const body = issue.body ?? "";
  const assigned = (issue.assignees ?? []).some((account) => sameName(account.login, agent));
  return {
    id: key("github-issue", String(issue.number)), source: SOURCE, threads: [{ source: SOURCE, id: String(issue.number) }],
    ...author(issue.user, agent), at: issue.created_at, text: `${issue.title}\n\n${body}`,
    ...(mentions(`${issue.title}\n${body}`, agent) || assigned ? { addressed: "mention" as const } : {}),
    channel: githubChannel(issue.number, issue.html_url), url: issue.html_url, meta: { number: issue.number, isPr: false, kind: "issue" },
  };
}

/** PR and issue numbers share one sequence, so this reuses the issue trigger's id format. */
export function pullTrigger(pull: Opened, agent: string): Trigger {
  return { ...issueTrigger(pull, agent), meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, kind: "pull" } };
}
