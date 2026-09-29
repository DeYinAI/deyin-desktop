/** Sentinel returned by {@link parseSseDataLine} when the stream is complete. */
export const SSE_DONE = Symbol("sse-done");

/**
 * How long a model stream may go without a single byte (keep-alive comments
 * count) before it is declared dead. Matches Codex's `stream_idle_timeout_ms`;
 * generous enough for a reasoning model that thinks for minutes before its
 * first token, short enough that a silently dropped connection does not hang
 * the run until the user notices and presses stop.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** A stream produced no data for longer than the idle limit. Retryable. */
export class StreamIdleTimeoutError extends Error {
  readonly idleMs: number;
  constructor(idleMs: number) {
    super(`No data from the model for ${Math.round(idleMs / 1000)}s — the connection looks stalled.`);
    // Not "TimeoutError"/"AbortError": the agent loop treats those names as a
    // user-requested stop, and a stall must be retried, not honoured as a stop.
    this.name = "StreamIdleTimeoutError";
    this.idleMs = idleMs;
  }
}

/** Idle limit in ms: `DEYIN_STREAM_IDLE_TIMEOUT_MS` when set (0 disables), else the default. */
export function streamIdleTimeoutMs(): number {
  const raw = typeof process !== "undefined" ? process.env?.DEYIN_STREAM_IDLE_TIMEOUT_MS : undefined;
  if (raw === undefined || raw.trim() === "") return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/**
 * `reader.read()` that gives up after `idleMs` of silence, cancelling the
 * reader so the socket is released. `idleMs <= 0` disables the limit.
 */
export async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs: number = streamIdleTimeoutMs(),
): ReturnType<ReadableStreamDefaultReader<T>["read"]> {
  if (!(idleMs > 0)) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StreamIdleTimeoutError(idleMs)), idleMs);
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } catch (err) {
    if (err instanceof StreamIdleTimeoutError) void reader.cancel(err).catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse one SSE `data:` line. Returns {@link SSE_DONE} for `[DONE]`,
 * null for keep-alives/malformed lines, otherwise the parsed JSON payload.
 */
export function parseSseDataLine(line: string): unknown | typeof SSE_DONE | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return SSE_DONE;
  if (payload.length === 0) return null;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

/**
 * Split an SSE body into parsed JSON payloads; ignores `event:`/`id:` lines
 * and keep-alives. Reads incrementally so deltas surface immediately.
 */
export async function* ssePayloads(res: Response, signal?: AbortSignal): AsyncGenerator<unknown> {
  if (!res.body) throw new Error(`Empty response body (${res.status}).`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await readWithIdleTimeout(reader);
    if (done) break;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // The last element is an incomplete line (or "" when the chunk ends with \n).
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseSseDataLine(line);
      if (parsed === SSE_DONE) return;
      if (parsed !== null) yield parsed;
    }
  }
  // Flush the trailing buffer: SSE streams are not required to end with "\n",
  // and a final `data:` line without one must not be dropped.
  if (buffer.length > 0) {
    const parsed = parseSseDataLine(buffer);
    if (parsed === SSE_DONE) return;
    if (parsed !== null) yield parsed;
  }
}
