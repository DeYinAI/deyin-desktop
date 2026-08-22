/** Sentinel returned by {@link parseSseDataLine} when the stream is complete. */
export const SSE_DONE = Symbol("sse-done");

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
    const { done, value } = await reader.read();
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
