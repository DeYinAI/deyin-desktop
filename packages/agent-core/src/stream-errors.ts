/**
 * Failure taxonomy for the model connection, shared by the streaming transports
 * (which raise these) and the agent loop (which decides what is worth retrying).
 *
 * The distinction that matters is transient vs. permanent. A dropped socket, a
 * 502 from a gateway, an `overloaded_error` frame: replaying the same request
 * will very likely work, and giving up on them is how a long autonomous run dies
 * three hours in for no fault of its own. A 401, a 400 or a content-policy
 * refusal: replaying changes nothing, so they surface immediately.
 */

import { StreamIdleTimeoutError } from "@deyin/host-core";

/** Upper bound on an honoured `Retry-After`; a longer wait is the user's call. */
const MAX_RETRY_AFTER_MS = 30_000;

/** Statuses where the same request is likely to succeed a moment later. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

/** A 429/5xx that is really "you are out of money", which no amount of waiting fixes. */
const PERMANENT_QUOTA =
  /insufficient[_ ]?(?:quota|balance|funds|credits?)|(?:exceeded|exhausted)[_ ](?:your[_ ])?(?:current[_ ])?quota|quota[_ ](?:exceeded|exhausted)|out of credits?|credit balance is too low|payment required|billing (?:hard )?limit|check your plan and billing|account (?:suspended|deactivated|disabled)|余额不足|额度不足|欠费/i;

/** Error `type`/`code` values that name a transient condition. */
const TRANSIENT_KIND =
  /server_error|overloaded|rate[_ ]?limit|timeout|timed[_ ]out|unavailable|internal|api_error|temporar|try again|busy|capacity/i;

/** Node/undici socket-level codes worth retrying. ECONNREFUSED/ENOTFOUND are deliberately absent: a wrong URL or a stopped local server will not fix itself. */
const TRANSIENT_NET_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** The provider answered with an HTTP error status. */
export class ProviderHttpError extends Error {
  readonly status: number;
  /** The server's `Retry-After`, capped, when it sent a usable one. */
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** The provider (or its gateway) reported an error inside an otherwise-200 stream. */
export class ProviderStreamError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "ProviderStreamError";
    this.transient = transient;
  }
}

/** `Retry-After` (seconds or an HTTP date) in ms, capped; undefined when absent or unusable. */
export function retryAfterMsOf(res: { headers: { get(name: string): string | null } }): number | undefined {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * Build an error from an in-stream error frame (`{ type, code, message }`, or a
 * bare string). Null when the frame carries no usable information, so a
 * gateway's benign `"error": {}` or `"error": null` is not mistaken for a fault.
 */
export function streamErrorFromFrame(raw: unknown): ProviderStreamError | null {
  if (typeof raw === "string") {
    const message = raw.trim();
    return message ? new ProviderStreamError(message, TRANSIENT_KIND.test(message)) : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as { message?: unknown; type?: unknown; code?: unknown };
  const message = typeof frame.message === "string" ? frame.message.trim() : "";
  const kinds = [frame.type, frame.code].filter((v): v is string | number => typeof v === "string" || typeof v === "number");
  if (!message && kinds.length === 0) return null;
  const status = kinds.map(Number).find((n) => Number.isInteger(n));
  const transient =
    kinds.some((k) => TRANSIENT_KIND.test(String(k))) ||
    (status !== undefined && TRANSIENT_STATUSES.has(status)) ||
    /overloaded|try again|temporar|rate limit/i.test(message);
  return new ProviderStreamError(message || kinds.join(" "), transient && !PERMANENT_QUOTA.test(message));
}

/** Why a failed model request is worth replaying, and how long the server asked us to wait. */
export interface TransientFailure {
  reason: string;
  retryAfterMs?: number;
}

function errorCode(err: Error): string | undefined {
  const own = (err as { code?: unknown }).code;
  if (typeof own === "string") return own;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Is this error a blip that replaying the same request should get past?
 * Returns null for anything else — auth failures, bad requests, tool bugs — which
 * must surface rather than be retried.
 */
export function classifyTransientFailure(err: unknown): TransientFailure | null {
  if (err instanceof StreamIdleTimeoutError) return { reason: err.message };
  if (err instanceof ProviderHttpError) {
    if (!TRANSIENT_STATUSES.has(err.status) || PERMANENT_QUOTA.test(err.message)) return null;
    return {
      reason: `The provider returned HTTP ${err.status}`,
      ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    };
  }
  if (err instanceof ProviderStreamError) {
    return err.transient ? { reason: `The provider reported an error mid-response: ${err.message.slice(0, 120)}` } : null;
  }
  if (!(err instanceof Error)) return null;

  // undici wraps the socket error in TypeError("fetch failed" | "terminated") and
  // puts the real code on `cause`. When there is a definitive code it decides on
  // its own: ECONNRESET is a blip, ECONNREFUSED (a stopped local server) is not.
  const code = errorCode(err);
  if (code !== undefined) {
    return TRANSIENT_NET_CODES.has(code) ? { reason: `Network error (${code})` } : null;
  }
  // undici's "fetch failed" always wraps what actually went wrong as `cause`. A
  // socket failure carries a code and was decided above; a cause without one
  // ("bad port", a header value fetch refuses) means the request was rejected
  // before it reached the network, and replaying it cannot change that.
  if (err.name === "TypeError" && /^fetch failed$/i.test(err.message) && (err as { cause?: unknown }).cause instanceof Error) {
    return null;
  }
  // No code: fall back to the wording. This is what a body cut off mid-stream
  // looks like, and what Chromium's network stack reports in Electron.
  if (err.name === "TypeError" && /^(?:terminated|fetch failed|network error|load failed|failed to fetch)$/i.test(err.message)) {
    return { reason: "The connection to the model was interrupted" };
  }
  if (
    /other side closed|socket hang up|premature close|connection (?:reset|closed)|stream (?:closed|ended) (?:unexpectedly|prematurely)|net::ERR_(?:CONNECTION_(?:RESET|CLOSED|ABORTED|TIMED_OUT)|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR|INCOMPLETE_CHUNKED_ENCODING)/i.test(
      err.message,
    )
  ) {
    return { reason: "The connection to the model was closed unexpectedly" };
  }
  return null;
}

/** Bounded, jittered exponential backoff for replaying a failed model request. */
export interface StreamRetryPolicy {
  /** Replays of one step before the error is surfaced. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** 1.5s, 3s, 6s, 12s, 20s: about 40s of patience in total for a provider blip to clear. */
export const DEFAULT_STREAM_RETRY_POLICY: StreamRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_500,
  maxDelayMs: 20_000,
};

/**
 * Delay before replay number `attempt` (1-based). ±25% jitter keeps parallel
 * agents from waking in lockstep; a server-supplied `Retry-After` is a floor.
 */
export function streamRetryDelayMs(
  attempt: number,
  policy: StreamRetryPolicy,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const backoff = Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempt - 1), policy.maxDelayMs);
  const jittered = backoff * (0.75 + random() * 0.5);
  const floor = retryAfterMs === undefined ? 0 : Math.min(retryAfterMs, policy.maxDelayMs);
  return Math.round(Math.max(jittered, floor));
}

/** Sleep that ends early — without throwing — when the run is aborted; callers re-check the signal. */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
