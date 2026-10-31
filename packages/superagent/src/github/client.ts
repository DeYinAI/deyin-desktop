/** Minimal GitHub REST client over an injected fetch: conditional requests, pagination, and rate-limit awareness. */

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponse>;

export class GithubError extends Error {
  readonly status: number;
  /** Milliseconds GitHub asked us to wait, when it did. */
  readonly retryAfterMs: number | undefined;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "GithubError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RequestResult<T> {
  status: number;
  data: T | undefined;
  etag: string | undefined;
  /** GitHub's requested minimum polling interval in seconds, if any. */
  pollInterval: number | undefined;
  headers: FetchResponse["headers"];
}

export interface ClientOptions {
  fetch: FetchLike;
  /** The agent account's token, read on every request so a changed token applies at once. */
  token(): string | undefined;
  apiBase?: string;
  now?(): number;
}

type Query = Record<string, string | number | boolean | undefined>;

export class GithubClient {
  private readonly base: string;
  constructor(private readonly options: ClientOptions) {
    this.base = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  }

  private url(path: string, query?: Query): string {
    const url = path.startsWith("http") ? new URL(path) : new URL(`${this.base}/${path.replace(/^\//, "")}`);
    for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
    return url.toString();
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    init: { query?: Query; body?: unknown; etag?: string; signal?: AbortSignal } = {},
  ): Promise<RequestResult<T>> {
    const token = this.options.token();
    if (!token) throw new GithubError(401, "No GitHub token is configured");
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "deyin-superagent",
    };
    if (init.etag) headers["If-None-Match"] = init.etag;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.options.fetch(this.url(path, init.query), {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    const pollInterval = Number(response.headers.get("x-poll-interval")) || undefined;
    const etag = response.headers.get("etag") ?? undefined;
    if (response.status === 304) return { status: 304, data: undefined, etag: init.etag, pollInterval, headers: response.headers };
    const text = await response.text();
    if (response.status >= 400) throw this.failure(response, text);
    let data: T | undefined;
    if (text.trim()) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        throw new GithubError(response.status, "GitHub returned a response that is not JSON");
      }
    }
    return { status: response.status, data, etag, pollInterval, headers: response.headers };
  }

  private failure(response: FetchResponse, text: string): GithubError {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      // keep the raw text
    }
    const retry = response.headers.get("retry-after");
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    let retryAfterMs: number | undefined;
    if (retry && Number(retry) > 0) retryAfterMs = Number(retry) * 1000;
    else if ((response.status === 403 || response.status === 429) && remaining === "0" && reset > 0) {
      retryAfterMs = Math.max(1000, reset * 1000 - (this.options.now?.() ?? Date.now()));
    }
    return new GithubError(response.status, `GitHub ${response.status}: ${message}`, retryAfterMs);
  }

  async get<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    const result = await this.request<T>("GET", path, { ...(query ? { query } : {}), ...(signal ? { signal } : {}) });
    return result.data as T;
  }

  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const result = await this.request<T>("POST", path, { body, ...(signal ? { signal } : {}) });
    return result.data as T;
  }

  /** Reads up to `maxPages` pages of 100 and returns every item; `truncated` when more remained. */
  async paginate<T>(path: string, query: Query = {}, options: { maxPages?: number; signal?: AbortSignal } = {}): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    const maxPages = options.maxPages ?? 10;
    let next: string | undefined = this.url(path, { per_page: 100, ...query });
    for (let page = 0; next && page < maxPages; page++) {
      const result: RequestResult<T[]> = await this.request<T[]>("GET", next, options.signal ? { signal: options.signal } : {});
      if (Array.isArray(result.data)) items.push(...result.data);
      next = /<([^>]+)>;\s*rel="next"/.exec(result.headers.get("link") ?? "")?.[1];
    }
    return { items, truncated: next !== undefined };
  }
}

/** The authenticated account, used to learn the agent's login. */
export interface GithubAccount {
  login: string;
  id: number;
  /** GitHub's private commit address for the account, which attributes commits without exposing a mailbox. */
  email: string;
}

/** The account the token belongs to. */
export async function authenticatedAccount(client: GithubClient, signal?: AbortSignal): Promise<GithubAccount> {
  const user = await client.get<{ login?: unknown; id?: unknown }>("user", undefined, signal);
  if (typeof user.login !== "string" || !user.login || typeof user.id !== "number") throw new GithubError(500, "GitHub did not return the account");
  return { login: user.login, id: user.id, email: `${user.id}+${user.login}@users.noreply.github.com` };
}

export async function canPush(client: GithubClient, repository: string, signal?: AbortSignal): Promise<boolean> {
  const repo = await client.get<{ permissions?: { push?: boolean }; archived?: boolean }>(`repos/${repository}`, undefined, signal);
  return repo.permissions?.push === true && repo.archived !== true;
}
