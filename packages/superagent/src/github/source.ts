/**
 * The GitHub Source: polls notifications of the agent account, the repository's observed streams, and the threads open tickets
 * follow, turning what it reads into Triggers and pull-request closes into thread events. Polling is cursor-based and every
 * trigger id is stable, so overlapping reads and restarts never duplicate work.
 */
import type { Engine } from "../core/engine.js";
import type { Trigger } from "../core/types.js";
import type { State } from "../core/state.js";
import { sameName } from "../core/text.js";
import type { SourceScope } from "../policy.js";
import type { Settings } from "../settings.js";
import { GithubError, type GithubClient } from "./client.js";
import {
  MARKER, SOURCE, commentTrigger, issueTrigger, parseComment, parseIssue, pullTrigger, type GhComment, type GhIssue, type PullRef,
} from "./triggers.js";

export interface PollReport {
  at: string;
  notifications: number;
  triggers: number;
  failures: string[];
  /** Seconds to wait before the next round. */
  intervalSeconds: number;
}

export interface SourceDeps {
  client: GithubClient;
  engine: Engine;
  state: State;
  settings(): Settings;
  /** The agent account's login, or `undefined` before it is known. */
  agentLogin(): string | undefined;
  now?(): Date;
}

/** Observation scope of this source: what it receives in full, per the settings' observe switches. */
export const githubScope = (settings: Settings): SourceScope => ({
  scope: ({ meta }) => {
    const kind = meta.kind;
    const row = kind === "issue" ? "issues" : kind === "pull" ? "pulls" : kind === "conversation" || kind === "inline" || kind === "review" ? "comments" : undefined;
    const observed =
      row === "issues" ? settings.github.observeIssues : row === "pulls" ? settings.github.observePulls : row === "comments" ? settings.github.observeComments : false;
    return { listened: true, observed, ...(row ? { row } : {}) };
  },
});

const numberOf = (url: string | null | undefined): number | undefined => {
  const match = /\/(\d+)\/?(?:#.*)?$/.exec(url ?? "");
  return match ? Number(match[1]) : undefined;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Pages of 50 notifications read in one round. */
const NOTIFICATION_PAGES = 10;
/** Pages of 100 read from a thread or stream in one round before the rest waits for the next. */
const READ_PAGES = 10;

const nextPage = (link: string | null | undefined): string | undefined => /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1];

/**
 * Where the next read of a time-ordered listing should start, given what this one saw: after its last item when it stopped
 * before the end (so the rest is read next round instead of being skipped), otherwise at the start of this round.
 * Never earlier than `since`, which keeps a listing of old items edited recently from moving the cursor back.
 */
function resumeAfter<T>(page: { items: T[]; truncated: boolean }, stamp: (item: T) => string | null | undefined, since: string, started: string): string {
  if (!page.truncated) return started;
  const last = page.items.length > 0 ? stamp(page.items[page.items.length - 1] as T) : undefined;
  return last && last > since ? last : since;
}

const earliest = (...times: string[]): string => times.reduce((a, b) => (a < b ? a : b));

export class GithubSource {
  constructor(private readonly deps: SourceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
  private get repo(): string {
    return this.deps.settings().github.repository;
  }
  private cursor(name: string): string | undefined {
    return this.deps.state.cursors[name];
  }
  private setCursor(name: string, value: string): void {
    this.deps.state.cursors[name] = value;
    this.deps.state.touch();
  }

  /** One polling round. Each step fails independently so the others still run; failures are reported, not thrown. */
  async poll(signal?: AbortSignal): Promise<PollReport> {
    const settings = this.deps.settings();
    const started = this.now();
    const report: PollReport = { at: started.toISOString(), notifications: 0, triggers: 0, failures: [], intervalSeconds: settings.github.pollSeconds };
    const agent = this.deps.agentLogin();
    if (!this.repo || !agent) return report;
    const round = { started, agent, signal, report, seen: new Map<number, GhIssue>(), retryAfterMs: 0 };
    const step = async (name: string, run: () => Promise<void>) => {
      try {
        await run();
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof GithubError && error.retryAfterMs) round.retryAfterMs = Math.max(round.retryAfterMs, error.retryAfterMs);
        report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await step("notifications", () => this.pollNotifications(round));
    await step("repository", () => this.pollRepository(round));
    await step("tickets", () => this.pollFollowed(round));
    report.intervalSeconds = Math.max(settings.github.pollSeconds, Math.ceil(round.retryAfterMs / 1000));
    return report;
  }

  // ---- notifications ------------------------------------------------------------------------------------------------

  private async pollNotifications(round: Round): Promise<void> {
    const { client } = this.deps;
    const since = this.cursor("gh:notifications") ?? round.started.toISOString();
    const etag = this.cursor("gh:notifications:etag");
    const result = await client.request<unknown[]>("GET", "notifications", {
      query: { participating: true, since, per_page: 50 },
      ...(etag ? { etag } : {}),
      ...(round.signal ? { signal: round.signal } : {}),
    });
    if (result.pollInterval) round.report.intervalSeconds = Math.max(round.report.intervalSeconds, result.pollInterval);
    if (result.status === 304 || !Array.isArray(result.data)) {
      if (result.etag) this.deps.state.cursors["gh:notifications:etag"] = result.etag;
      this.setCursor("gh:notifications", since);
      return;
    }
    const notifications: unknown[] = [...result.data];
    let next = nextPage(result.headers.get("link"));
    for (let page = 1; next && page < NOTIFICATION_PAGES; page++) {
      const more = await client.request<unknown[]>("GET", next, round.signal ? { signal: round.signal } : {});
      if (Array.isArray(more.data)) notifications.push(...more.data);
      next = nextPage(more.headers.get("link"));
    }
    // Beyond the pages read, the rest stays unread: the cursor and the etag stay as they were, so the next round asks again.
    const truncated = next !== undefined;
    if (truncated) round.report.failures.push(`notifications: more than ${NOTIFICATION_PAGES * 50} are waiting; reading the newest first`);
    else if (result.etag) this.deps.state.cursors["gh:notifications:etag"] = result.etag;
    const numbers = new Set<number>();
    for (const item of notifications) {
      if (!isRecord(item) || !isRecord(item.repository) || !isRecord(item.subject)) continue;
      if (typeof item.repository.full_name !== "string" || !sameName(item.repository.full_name, this.repo)) continue;
      const type = item.subject.type;
      if (type !== "Issue" && type !== "PullRequest") continue;
      const number = numberOf(typeof item.subject.url === "string" ? item.subject.url : undefined);
      if (number) numbers.add(number);
    }
    round.report.notifications += numbers.size;
    let failed = false;
    for (const number of numbers) {
      try {
        await this.readThread(round, number, since, true);
      } catch (error) {
        failed = true;
        if (round.signal?.aborted) return;
        round.report.failures.push(`#${number}: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof GithubError && error.retryAfterMs) round.retryAfterMs = Math.max(round.retryAfterMs, error.retryAfterMs);
      }
    }
    // A failed thread keeps the cursor where it was, so its notification is read again next round.
    if (!failed && !truncated) this.setCursor("gh:notifications", round.started.toISOString());
  }

  // ---- threads -----------------------------------------------------------------------------------------------------

  private async issue(round: Round, number: number): Promise<GhIssue> {
    const cached = round.seen.get(number);
    if (cached) return cached;
    const issue = parseIssue(await this.deps.client.get<unknown>(`repos/${this.repo}/issues/${number}`, undefined, round.signal));
    round.seen.set(number, issue);
    return issue;
  }

  /**
   * Reads one issue or PR: its opening post (when it addresses the agent or is observed), comments and, for a PR, review
   * comments and reviews newer than the thread's cursor, then reports whether a PR closed.
   */
  private async readThread(round: Round, number: number, fallbackSince: string, notified: boolean): Promise<void> {
    const issue = await this.issue(round, number);
    const settings = this.deps.settings();
    const isPr = !!issue.pull_request;
    const ref: PullRef = { number, isPr, url: issue.html_url, ...(isPr ? { prAuthor: issue.user.login } : {}) };
    const cursorName = `gh:thread:${number}`;
    const since = this.cursor(cursorName) ?? fallbackSince;
    const known = this.cursor(cursorName) !== undefined;
    if (notified && !known) {
      const opened = isPr ? pullTrigger(issue, round.agent) : issueTrigger(issue, round.agent);
      const watching = isPr ? settings.github.observePulls : settings.github.observeIssues;
      if (opened.addressed || watching) this.receive(round, opened);
    }
    const started = round.started.toISOString();
    const options = { maxPages: READ_PAGES, ...(round.signal ? { signal: round.signal } : {}) };
    const created = (raw: unknown): string | null | undefined => parseComment(raw).created_at;
    const comments = await this.deps.client.paginate<unknown>(`repos/${this.repo}/issues/${number}/comments`, { since }, options);
    for (const raw of comments.items) this.comment(round, parseComment(raw), ref, "conversation");
    // Each listing is oldest first, so one that stopped early resumes after its last item; the thread's cursor is the earliest of them.
    let resume = resumeAfter(comments, created, since, started);
    if (isPr) {
      const review = await this.deps.client.paginate<unknown>(`repos/${this.repo}/pulls/${number}/comments`, { since }, options);
      for (const raw of review.items) this.comment(round, parseComment(raw), ref, "inline");
      const reviews = await this.deps.client.paginate<unknown>(`repos/${this.repo}/pulls/${number}/reviews`, {}, options);
      for (const raw of reviews.items) {
        const parsed = parseComment(raw);
        if ((parsed.submitted_at ?? "") > since) this.comment(round, parsed, ref, "review");
      }
      resume = earliest(resume, resumeAfter(review, created, since, started), resumeAfter(reviews, (raw) => parseComment(raw).submitted_at, since, started));
      this.pullState(issue, number);
    }
    this.setCursor(cursorName, resume);
  }

  private pullState(issue: GhIssue, number: number): void {
    const threadRef = { source: SOURCE, id: String(number) };
    if (issue.state === "closed") {
      const merged = typeof issue.pull_request?.merged_at === "string";
      this.deps.engine.threadClosed(threadRef, merged ? "merged" : "closed");
    } else {
      this.deps.engine.threadReopened(threadRef);
    }
  }

  private comment(round: Round, comment: GhComment, ref: PullRef, kind: "conversation" | "inline" | "review"): void {
    if (sameName(comment.user.login, round.agent) || (comment.body ?? "").includes(MARKER)) return;
    // A bodyless COMMENTED review only announces its inline comments, which arrive on their own.
    if (kind === "review" && !(comment.body ?? "").trim() && (!comment.state || comment.state === "COMMENTED")) return;
    this.receive(round, commentTrigger(comment, ref, kind, round.agent, this.now()));
  }

  private receive(round: Round, trigger: Trigger): void {
    if (this.deps.engine.receive(trigger) === "stored") round.report.triggers++;
  }

  // ---- repository streams ------------------------------------------------------------------------------------------

  private async pollRepository(round: Round): Promise<void> {
    const settings = this.deps.settings().github;
    if (!settings.observeIssues && !settings.observePulls) this.deps.state.cursors["gh:stream:issues"] = round.started.toISOString();
    else await this.streamIssues(round);
    if (!settings.observeComments) this.deps.state.cursors["gh:stream:comments"] = round.started.toISOString();
    else await this.streamComments(round);
  }

  private async streamIssues(round: Round): Promise<void> {
    const settings = this.deps.settings().github;
    const since = this.cursor("gh:stream:issues") ?? round.started.toISOString();
    const page = await this.deps.client.paginate<unknown>(`repos/${this.repo}/issues`, { state: "open", sort: "created", direction: "asc", since }, { maxPages: READ_PAGES, ...(round.signal ? { signal: round.signal } : {}) });
    let newest = since;
    for (const raw of page.items) {
      const issue = parseIssue(raw);
      if (issue.created_at <= since) continue;
      newest = issue.created_at > newest ? issue.created_at : newest;
      const isPr = !!issue.pull_request;
      if (isPr ? !settings.observePulls : !settings.observeIssues) continue;
      if (sameName(issue.user.login, round.agent)) continue;
      this.receive(round, isPr ? pullTrigger(issue, round.agent) : issueTrigger(issue, round.agent));
    }
    this.setCursor("gh:stream:issues", page.truncated ? newest : round.started.toISOString());
  }

  private async streamComments(round: Round): Promise<void> {
    const since = this.cursor("gh:stream:comments") ?? round.started.toISOString();
    const opts = { maxPages: READ_PAGES, ...(round.signal ? { signal: round.signal } : {}) };
    const conversation = await this.deps.client.paginate<unknown>(`repos/${this.repo}/issues/comments`, { since, sort: "created", direction: "asc" }, opts);
    for (const raw of conversation.items) {
      const parsed = parseComment(raw);
      const number = numberOf((raw as Record<string, unknown>).issue_url as string | undefined);
      if (!number || (parsed.created_at ?? "") <= since) continue;
      this.comment(round, parsed, { number, isPr: /\/pull\//.test(parsed.html_url ?? "") }, "conversation");
    }
    const inline = await this.deps.client.paginate<unknown>(`repos/${this.repo}/pulls/comments`, { since, sort: "created", direction: "asc" }, opts);
    for (const raw of inline.items) {
      const parsed = parseComment(raw);
      const number = numberOf((raw as Record<string, unknown>).pull_request_url as string | undefined);
      if (!number || (parsed.created_at ?? "") <= since) continue;
      this.comment(round, parsed, { number, isPr: true }, "inline");
    }
    // Both listings are oldest first; one that stopped early resumes after its last item, and the cursor is the earlier of the two.
    const started = round.started.toISOString();
    const created = (raw: unknown): string | null | undefined => parseComment(raw).created_at;
    this.setCursor("gh:stream:comments", earliest(resumeAfter(conversation, created, since, started), resumeAfter(inline, created, since, started)));
  }

  // ---- followed threads --------------------------------------------------------------------------------------------

  /** Reads every GitHub thread an open ticket is subscribed to, so replies and PR state reach it without a mention. */
  private async pollFollowed(round: Round): Promise<void> {
    // A thread nobody has read yet is read from its oldest open ticket's start; trigger ids are stable, so overlap is harmless.
    const numbers = new Map<number, string>();
    for (const ticket of this.deps.state.openTickets()) {
      for (const thread of this.deps.state.threads.values()) {
        if (thread.ref.source !== SOURCE || !thread.subscriptions.includes(ticket.id)) continue;
        const number = Number(thread.ref.id);
        if (!Number.isInteger(number) || number <= 0) continue;
        const earlier = numbers.get(number);
        if (!earlier || ticket.createdAt < earlier) numbers.set(number, ticket.createdAt);
      }
    }
    for (const [number, since] of numbers) {
      try {
        await this.readThread(round, number, since, false);
      } catch (error) {
        if (round.signal?.aborted) return;
        if (error instanceof GithubError && error.status === 404) continue;
        if (error instanceof GithubError && error.retryAfterMs) round.retryAfterMs = Math.max(round.retryAfterMs, error.retryAfterMs);
        round.report.failures.push(`#${number}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

interface Round {
  started: Date;
  agent: string;
  signal: AbortSignal | undefined;
  report: PollReport;
  seen: Map<number, GhIssue>;
  retryAfterMs: number;
}
