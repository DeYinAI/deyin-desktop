import type { FetchLike, FetchResponse } from "../src/github/client.js";

interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type?: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  in_reply_to_id?: number;
  path?: string;
  line?: number;
}
interface FakeReview extends FakeComment {
  state: string;
  submitted_at: string;
}
interface FakeIssue {
  number: number;
  title: string;
  body: string;
  user: { login: string; type?: string };
  created_at: string;
  state: "open" | "closed";
  pr?: { merged: boolean; head: string; base: string };
  comments: FakeComment[];
  reviewComments: FakeComment[];
  reviews: FakeReview[];
  assignees: { login: string }[];
}

/** A tiny in-memory GitHub REST API: enough routes for the source, channel, reader and pull-claim code. */
export class FakeGithub {
  readonly repo = "acme/app";
  readonly agent = "agent-bot";
  clock = { now: new Date("2026-01-01T00:00:00.000Z") };
  readonly issues = new Map<number, FakeIssue>();
  readonly notifications: { number: number; updated_at: string; reason: string }[] = [];
  readonly requests: { method: string; path: string }[] = [];
  readonly files = new Map<string, string>();
  failures: ((method: string, path: string) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined)[] = [];
  private nextId = 1000;

  tick(ms = 1000): string {
    this.clock.now = new Date(this.clock.now.getTime() + ms);
    return this.stamp();
  }
  /** As GitHub writes times: whole seconds, no fraction (the runtime's own are `…:00.000Z`). */
  private stamp = () => this.clock.now.toISOString().replace(/\.\d{3}Z$/, "Z");

  addIssue(input: { number: number; title?: string; body?: string; user?: string; pr?: { head?: string; base?: string }; assignees?: string[] }): FakeIssue {
    const issue: FakeIssue = {
      number: input.number, title: input.title ?? `Issue ${input.number}`, body: input.body ?? "", user: { login: input.user ?? "alice" },
      created_at: this.stamp(), state: "open", comments: [], reviewComments: [], reviews: [], assignees: (input.assignees ?? []).map((login) => ({ login })),
      ...(input.pr ? { pr: { merged: false, head: input.pr.head ?? `agent/pr-${input.number}`, base: input.pr.base ?? "main" } } : {}),
    };
    this.issues.set(input.number, issue);
    return issue;
  }

  addComment(number: number, input: { user: string; body: string; type?: string }): FakeComment {
    const issue = this.issues.get(number)!;
    const id = this.nextId++;
    const at = this.stamp();
    const comment: FakeComment = {
      id, body: input.body, user: { login: input.user, ...(input.type ? { type: input.type } : {}) }, created_at: at, updated_at: at,
      html_url: `https://github.com/${this.repo}/${issue.pr ? "pull" : "issues"}/${number}#issuecomment-${id}`,
    };
    issue.comments.push(comment);
    return comment;
  }

  addReviewComment(number: number, input: { user: string; body: string; path?: string; line?: number; replyTo?: number }): FakeComment {
    const issue = this.issues.get(number)!;
    const id = this.nextId++;
    const at = this.stamp();
    const comment: FakeComment = {
      id, body: input.body, user: { login: input.user }, created_at: at, updated_at: at, path: input.path ?? "README.md", line: input.line ?? 3,
      html_url: `https://github.com/${this.repo}/pull/${number}#discussion_r${id}`, ...(input.replyTo ? { in_reply_to_id: input.replyTo } : {}),
    };
    issue.reviewComments.push(comment);
    return comment;
  }

  notify(number: number, reason = "mention"): void {
    this.notifications.push({ number, updated_at: this.stamp(), reason });
  }
  close(number: number, merged = false): void {
    const issue = this.issues.get(number)!;
    issue.state = "closed";
    if (issue.pr) issue.pr.merged = merged;
  }
  reopen(number: number): void {
    this.issues.get(number)!.state = "open";
  }
  /** Comments the agent posted, newest last. */
  posted(number: number): FakeComment[] {
    return this.issues.get(number)!.comments.filter((comment) => comment.user.login === this.agent);
  }

  private issueJson(issue: FakeIssue) {
    return {
      number: issue.number, title: issue.title, body: issue.body, user: issue.user, state: issue.state, created_at: issue.created_at,
      updated_at: issue.created_at, id: issue.number, html_url: `https://github.com/${this.repo}/${issue.pr ? "pull" : "issues"}/${issue.number}`,
      assignees: issue.assignees,
      ...(issue.pr ? { pull_request: { url: `https://api.github.com/repos/${this.repo}/pulls/${issue.number}`, merged_at: issue.pr.merged ? this.stamp() : null } } : {}),
    };
  }

  readonly fetch: FetchLike = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\//, "");
    this.requests.push({ method, path: path + url.search });
    for (const failure of this.failures) {
      const failed = failure(method, path);
      if (failed) return this.respond(failed.status, failed.body ?? { message: "failure" }, failed.headers);
    }
    const since = url.searchParams.get("since") ?? "";
    const page = Number(url.searchParams.get("page") ?? 1);
    const per = Number(url.searchParams.get("per_page") ?? 30);
    const slice = <T>(items: T[]) => items.slice((page - 1) * per, page * per);
    /** A listing page, with the Link header GitHub sends while more pages remain. */
    const list = <T>(items: T[], headers: Record<string, string> = {}): FetchResponse => {
      const next = new URL(rawUrl);
      next.searchParams.set("page", String(page + 1));
      return this.respond(200, slice(items), page * per < items.length ? { ...headers, link: `<${next.toString()}>; rel="next"` } : headers);
    };
    const after = <T extends { updated_at?: string; created_at?: string }>(items: T[]) => items.filter((item) => !since || Date.parse(item.updated_at ?? item.created_at ?? "") > Date.parse(since));
    let match: RegExpExecArray | null;
    if (path === "user") return this.respond(200, { login: this.agent, id: 4242 });
    if (path === `repos/${this.repo}`) return this.respond(200, { permissions: { push: true }, archived: false });
    if (path === "notifications") {
      const fresh = this.notifications.filter((item) => !since || Date.parse(item.updated_at) > Date.parse(since));
      const etag = `"n${fresh.length}-${this.notifications.length}"`;
      if (init?.headers?.["If-None-Match"] === etag && fresh.length === 0) return this.respond(304, undefined, { etag });
      return list(
        fresh.map((item) => ({
          id: String(item.number), reason: item.reason, updated_at: item.updated_at, repository: { full_name: this.repo },
          subject: { type: this.issues.get(item.number)?.pr ? "PullRequest" : "Issue", url: `https://api.github.com/repos/${this.repo}/issues/${item.number}` },
        })),
        { etag, "x-poll-interval": "30" },
      );
    }
    if ((match = new RegExp(`^repos/${this.repo}/issues/(\\d+)$`).exec(path))) {
      const issue = this.issues.get(Number(match[1]));
      return issue ? this.respond(200, this.issueJson(issue)) : this.respond(404, { message: "Not Found" });
    }
    if ((match = new RegExp(`^repos/${this.repo}/issues/(\\d+)/comments$`).exec(path))) {
      if (method === "POST") {
        const issue = this.issues.get(Number(match[1]));
        if (!issue) return this.respond(404, { message: "Not Found" });
        const body = JSON.parse(init!.body!) as { body: string };
        this.tick();
        return this.respond(201, this.addComment(issue.number, { user: this.agent, body: body.body }));
      }
      const issue = this.issues.get(Number(match[1]));
      return issue ? list(after(issue.comments)) : this.respond(404, { message: "Not Found" });
    }
    if ((match = new RegExp(`^repos/${this.repo}/pulls/(\\d+)/comments$`).exec(path))) {
      const issue = this.issues.get(Number(match[1]));
      return issue ? list(after(issue.reviewComments)) : this.respond(404, { message: "Not Found" });
    }
    if ((match = new RegExp(`^repos/${this.repo}/pulls/(\\d+)/comments/(\\d+)/replies$`).exec(path))) {
      const issue = this.issues.get(Number(match[1]));
      if (!issue) return this.respond(404, { message: "Not Found" });
      const body = JSON.parse(init!.body!) as { body: string };
      this.tick();
      return this.respond(201, this.addReviewComment(issue.number, { user: this.agent, body: body.body, replyTo: Number(match[2]) }));
    }
    if ((match = new RegExp(`^repos/${this.repo}/pulls/comments/(\\d+)$`).exec(path))) {
      for (const issue of this.issues.values()) {
        const found = issue.reviewComments.find((comment) => comment.id === Number(match![1]));
        if (found) return this.respond(200, found);
      }
      return this.respond(404, { message: "Not Found" });
    }
    if ((match = new RegExp(`^repos/${this.repo}/pulls/(\\d+)/reviews$`).exec(path))) {
      const issue = this.issues.get(Number(match[1]));
      return issue ? list(issue.reviews) : this.respond(404, { message: "Not Found" });
    }
    if ((match = new RegExp(`^repos/${this.repo}/pulls/(\\d+)$`).exec(path))) {
      const issue = this.issues.get(Number(match[1]));
      if (!issue?.pr) return this.respond(404, { message: "Not Found" });
      return this.respond(200, { number: issue.number, head: { ref: issue.pr.head, sha: "abc123" }, base: { ref: issue.pr.base }, merged: issue.pr.merged, draft: false });
    }
    if (path === `repos/${this.repo}/issues`) {
      const open = [...this.issues.values()].filter((issue) => issue.state === "open").map((issue) => this.issueJson(issue));
      return list(open);
    }
    if (path === `repos/${this.repo}/issues/comments`) {
      const all = [...this.issues.values()].flatMap((issue) => issue.comments.map((comment) => ({ ...comment, issue_url: `https://api.github.com/repos/${this.repo}/issues/${issue.number}` })));
      return list(after(all));
    }
    if (path === `repos/${this.repo}/pulls/comments`) {
      const all = [...this.issues.values()].flatMap((issue) => issue.reviewComments.map((comment) => ({ ...comment, pull_request_url: `https://api.github.com/repos/${this.repo}/pulls/${issue.number}` })));
      return list(after(all));
    }
    if ((match = new RegExp(`^repos/${this.repo}/commits/[^/]+/check-runs$`).exec(path))) return this.respond(200, { check_runs: [{ name: "ci", status: "completed", conclusion: "success", html_url: "https://example.test/ci" }] });
    if ((match = new RegExp(`^repos/${this.repo}/commits/[^/]+/status$`).exec(path))) return this.respond(200, { state: "success", statuses: [] });
    if ((match = new RegExp(`^repos/${this.repo}/contents/(.+)$`).exec(path))) {
      const file = this.files.get(decodeURIComponent(match[1]!));
      return file === undefined ? this.respond(404, { message: "Not Found" }) : this.respond(200, { type: "file", encoding: "base64", content: Buffer.from(file).toString("base64"), size: file.length });
    }
    return this.respond(404, { message: `unhandled ${method} ${path}` });
  };

  private respond(status: number, body?: unknown, headers: Record<string, string> = {}): FetchResponse {
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return { status, headers: { get: (name) => lower[name.toLowerCase()] ?? null }, text: async () => (body === undefined ? "" : JSON.stringify(body)) };
  }
}
