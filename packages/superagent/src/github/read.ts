/**
 * Read-only GitHub context for the agents: the `github/...` resources of orchestrator_read and the thread window the
 * orchestrator assesses a proactive candidate by. Reading never creates tickets or sends messages.
 */
import { UserError } from "../core/errors.js";
import { textPage } from "../core/text.js";
import type { Trigger } from "../core/types.js";
import { GithubError, type GithubClient } from "./client.js";
import { isHumanLogin, parseComment, parseIssue, type GhComment, type GhIssue } from "./triggers.js";

const PAGE = 20;
const ENTRY_CHARS = 8000;
const WINDOW = { first: 5, around: 5, trigger: 4000, near: 1200, other: 400, stub: 50 };

export interface Entry {
  id: number;
  from: string;
  at: string;
  text: string;
  url?: string;
  reply_to?: number;
  path?: string;
  line?: number;
  bot?: true;
  state?: string;
  text_chars?: number;
}

function entryOf(comment: GhComment): Entry {
  const text = comment.body ?? "";
  const at = comment.submitted_at ?? comment.updated_at ?? comment.created_at ?? "";
  const line = comment.line ?? comment.original_line ?? undefined;
  return {
    id: comment.id,
    from: comment.user.login,
    at,
    text: text.length > ENTRY_CHARS ? text.slice(0, ENTRY_CHARS) : text,
    ...(text.length > ENTRY_CHARS ? { text_chars: text.length } : {}),
    ...(comment.html_url ? { url: comment.html_url } : {}),
    ...(comment.in_reply_to_id ? { reply_to: comment.in_reply_to_id } : {}),
    ...(comment.path ? { path: comment.path } : {}),
    ...(line != null ? { line } : {}),
    ...(comment.state && comment.state !== "COMMENTED" ? { state: comment.state } : {}),
    ...(isHumanLogin(comment.user) ? {} : { bot: true as const }),
  };
}

const listPage = (resource: string, entries: Entry[], page: number, more: boolean) => ({
  resource,
  page,
  entries,
  ...(more ? { next_resource: resource.replace(/\/\d+$/, `/${page + 1}`) } : {}),
});

/** A message of a thread, for assessment windows. */
export interface ThreadMessage {
  id: string;
  kind: "issue" | "conversation" | "inline" | "review";
  from: string;
  at: string;
  text: string;
  url?: string;
  bot: boolean;
  replyTo?: string;
  path?: string;
  line?: number;
}

export interface ReaderDeps {
  client: GithubClient;
  repository(): string;
}

export class GithubReader {
  constructor(private readonly deps: ReaderDeps) {}

  private get repo(): string {
    return this.deps.repository();
  }

  private async issue(number: number, signal?: AbortSignal): Promise<GhIssue> {
    return parseIssue(await this.deps.client.get<unknown>(`repos/${this.repo}/issues/${number}`, undefined, signal));
  }

  /** Serves a `github/...` resource of orchestrator_read; `path` is the part after `github/`. */
  async resource(path: string, offset: number, limit: number | undefined, signal?: AbortSignal): Promise<unknown> {
    const parts = path.split("/").filter(Boolean);
    const [kind, rawNumber, section, rawArg] = parts;
    const number = Number(rawNumber);
    if ((kind !== "issues" && kind !== "pulls") || !Number.isInteger(number) || number <= 0) throw new UserError("invalid", `Unknown github resource "${path}"`);
    const resource = `github/${parts.join("/")}`;
    const pr = kind === "pulls";
    const page = Math.max(1, Number(rawArg) || 1);
    try {
      if (!section) {
        const issue = await this.issue(number, signal);
        if (!!issue.pull_request !== pr) throw new UserError("invalid", `#${number} is ${issue.pull_request ? "a pull request; read github/pulls/" : "an issue; read github/issues/"}${number}`);
        const body = await this.description(issue, pr, signal);
        return { ...textPage(resource, body.text, offset, limit ?? 4000), meta: body.meta };
      }
      if (section === "comments") {
        const path = pr ? `repos/${this.repo}/pulls/${number}/comments` : `repos/${this.repo}/issues/${number}/comments`;
        const result = await this.deps.client.get<unknown[]>(path, { per_page: PAGE, page }, signal);
        return listPage(resource.replace(/\/comments\/?\d*$/, `/comments/${page}`), (result ?? []).map((raw) => entryOf(parseComment(raw))), page, (result ?? []).length === PAGE);
      }
      if (pr && section === "reviews") {
        const result = await this.deps.client.get<unknown[]>(`repos/${this.repo}/pulls/${number}/reviews`, { per_page: PAGE, page }, signal);
        return listPage(resource.replace(/\/reviews\/?\d*$/, `/reviews/${page}`), (result ?? []).map((raw) => entryOf(parseComment(raw))), page, (result ?? []).length === PAGE);
      }
      if (pr && section === "thread") {
        const id = Number(rawArg);
        if (!Number.isInteger(id)) throw new UserError("invalid", "github/pulls/<number>/thread/<comment-id> needs a comment id");
        const all = await this.deps.client.paginate<unknown>(`repos/${this.repo}/pulls/${number}/comments`, {}, { maxPages: 10, ...(signal ? { signal } : {}) });
        const comments = all.items.map(parseComment);
        const target = comments.find((comment) => comment.id === id);
        if (!target) throw new UserError("invalid", `Review comment ${id} is not on #${number}`);
        const root = target.in_reply_to_id ?? target.id;
        const thread = comments.filter((comment) => comment.id === root || comment.in_reply_to_id === root).sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
        return { resource, root, entries: thread.map(entryOf) };
      }
      if (pr && section === "checks") return await this.checks(number, signal);
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) throw new UserError("invalid", `${resource} was not found`);
      throw error;
    }
    throw new UserError("invalid", `Unknown github resource "${path}"`);
  }

  private async description(issue: GhIssue, pr: boolean, signal?: AbortSignal) {
    const meta: Record<string, unknown> = { number: issue.number, title: issue.title, state: issue.state, from: issue.user.login, at: issue.created_at, url: issue.html_url };
    if (pr) {
      const pull = await this.deps.client.get<{ head?: { ref?: string; sha?: string }; base?: { ref?: string }; merged?: boolean; draft?: boolean }>(`repos/${this.repo}/pulls/${issue.number}`, undefined, signal);
      Object.assign(meta, { head: pull.head?.ref, head_sha: pull.head?.sha, base: pull.base?.ref, merged: pull.merged === true, draft: pull.draft === true });
    }
    return { text: issue.body ?? "", meta };
  }

  private async checks(number: number, signal?: AbortSignal) {
    const pull = await this.deps.client.get<{ head?: { sha?: string } }>(`repos/${this.repo}/pulls/${number}`, undefined, signal);
    const sha = pull.head?.sha;
    if (!sha) return { resource: `github/pulls/${number}/checks`, checks: [] };
    const runs = await this.deps.client.get<{ check_runs?: { name?: string; status?: string; conclusion?: string | null; html_url?: string }[] }>(`repos/${this.repo}/commits/${sha}/check-runs`, { per_page: 50 }, signal);
    const status = await this.deps.client.get<{ state?: string; statuses?: { context?: string; state?: string; target_url?: string | null }[] }>(`repos/${this.repo}/commits/${sha}/status`, undefined, signal);
    return {
      resource: `github/pulls/${number}/checks`,
      sha,
      checks: (runs.check_runs ?? []).map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion ?? null, url: run.html_url })),
      statuses: (status.statuses ?? []).map((item) => ({ context: item.context, state: item.state, url: item.target_url ?? null })),
      combined: status.state,
    };
  }

  // ---- assessment window -------------------------------------------------------------------------------------------

  /** Every message of an issue or PR in time order, capped at 300, oldest first. */
  async loadThread(number: number, signal?: AbortSignal): Promise<{ messages: ThreadMessage[]; isPr: boolean; truncated: boolean }> {
    const issue = await this.issue(number, signal);
    const isPr = !!issue.pull_request;
    const opts = { maxPages: 3, ...(signal ? { signal } : {}) };
    const [conversation, inline, reviews] = await Promise.all([
      this.deps.client.paginate<unknown>(`repos/${this.repo}/issues/${number}/comments`, {}, opts),
      isPr ? this.deps.client.paginate<unknown>(`repos/${this.repo}/pulls/${number}/comments`, {}, opts) : Promise.resolve({ items: [], truncated: false }),
      isPr ? this.deps.client.paginate<unknown>(`repos/${this.repo}/pulls/${number}/reviews`, {}, opts) : Promise.resolve({ items: [], truncated: false }),
    ]);
    const message = (comment: GhComment, kind: ThreadMessage["kind"], prefix: string): ThreadMessage => ({
      id: `${prefix}${comment.id}`,
      kind,
      from: comment.user.login,
      at: comment.submitted_at ?? comment.updated_at ?? comment.created_at ?? "",
      text: [comment.state && comment.state !== "COMMENTED" ? `${comment.state} review` : "", comment.body ?? ""].filter(Boolean).join("\n\n"),
      bot: !isHumanLogin(comment.user),
      ...(comment.html_url ? { url: comment.html_url } : {}),
      ...(comment.in_reply_to_id ? { replyTo: `r${comment.in_reply_to_id}` } : {}),
      ...(comment.path ? { path: comment.path } : {}),
      ...((comment.line ?? comment.original_line) != null ? { line: (comment.line ?? comment.original_line)! } : {}),
    });
    const all: ThreadMessage[] = [
      { id: "issue", kind: "issue" as const, from: issue.user.login, at: issue.created_at, text: `${issue.title}\n\n${issue.body ?? ""}`, bot: !isHumanLogin(issue.user), url: issue.html_url },
      ...conversation.items.map((raw) => message(parseComment(raw), "conversation", "c")),
      ...inline.items.map((raw) => message(parseComment(raw), "inline", "r")),
      ...reviews.items.map((raw) => message(parseComment(raw), "review", "v")).filter((item) => item.text.trim()),
    ].sort((a, b) => a.at.localeCompare(b.at));
    return { messages: all.slice(0, 300), isPr, truncated: all.length > 300 || conversation.truncated || inline.truncated || reviews.truncated };
  }

  /** The id of the thread message a trigger is. */
  static messageId(trigger: Trigger): string {
    const kind = trigger.meta.kind;
    const id = trigger.meta.commentId;
    if (typeof id === "number") return `${kind === "inline" ? "r" : kind === "review" ? "v" : "c"}${id}`;
    return "issue";
  }

  /** The window the orchestrator assesses: first messages, those around the trigger, the rest as stubs. */
  static window(messages: readonly ThreadMessage[], triggerMessage: string) {
    const index = Math.max(0, messages.findIndex((item) => item.id === triggerMessage));
    const shown = new Set<number>();
    for (let i = 0; i < Math.min(WINDOW.first, messages.length); i++) shown.add(i);
    for (let i = Math.max(0, index - WINDOW.around); i <= Math.min(messages.length - 1, index + WINDOW.around); i++) shown.add(i);
    return messages.map((item, i) => {
      if (!shown.has(i)) return { id: item.id, from: item.from, at: item.at, chars: item.text.length, stub: item.text.replace(/\s+/g, " ").slice(0, WINDOW.stub), ...(item.bot ? { bot: true } : {}) };
      const limit = i === index ? WINDOW.trigger : Math.abs(i - index) <= 1 ? WINDOW.near : WINDOW.other;
      return { ...item, text: item.text.slice(0, limit), ...(item.text.length > limit ? { chars: item.text.length } : {}), ...(i === index ? { trigger: true } : {}) };
    });
  }

  /** Reads a repository file or directory at the default branch (for assessment context). */
  async repositoryPath(path: string, directory: boolean, offset: number, signal?: AbortSignal): Promise<unknown> {
    if (path.includes("..") || path.startsWith("/")) throw new UserError("invalid", "path must be repository-relative");
    const result = await this.deps.client.get<unknown>(`repos/${this.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, undefined, signal).catch((error: unknown) => {
      if (error instanceof GithubError && error.status === 404) throw new UserError("invalid", `${path} was not found`);
      throw error;
    });
    if (directory) {
      if (!Array.isArray(result)) throw new UserError("invalid", `${path} is a file; use resource=file`);
      return { path, entries: result.slice(0, 200).map((item) => ({ name: (item as { name?: string }).name, type: (item as { type?: string }).type, size: (item as { size?: number }).size })) };
    }
    const file = result as { type?: string; content?: string; encoding?: string; size?: number };
    if (Array.isArray(result) || file.type !== "file" || typeof file.content !== "string") throw new UserError("invalid", `${path} is not a file; use resource=directory`);
    const text = file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    return textPage(`file/${path}`, text, offset, 8000);
  }
}
