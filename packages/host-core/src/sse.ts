/**
 * Node SSE framing with optional @deyin/native-core fast path. Browser-safe
 * implementations live in sse-core.ts and are re-exported from shared.ts.
 */
import { createRequire } from "node:module";
import { SSE_DONE, parseSseDataLine as parseSseDataLineCore, ssePayloads } from "./sse-core.js";

export { SSE_DONE, ssePayloads };

interface NativeSseLine {
  payload: string | null;
  isDone: boolean;
}

let nativeSse: { parseSseDataLine(line: string): NativeSseLine } | null | undefined;

function loadNativeSse(): typeof nativeSse {
  if (nativeSse !== undefined) return nativeSse;
  try {
    if (typeof process === "undefined" || !process.versions?.node) {
      nativeSse = null;
      return nativeSse;
    }
    const mod = createRequire(import.meta.url)("@deyin/native-core") as {
      available: boolean;
      parseSseDataLine(line: string): NativeSseLine;
    };
    nativeSse = mod?.available ? mod : null;
  } catch {
    nativeSse = null;
  }
  return nativeSse;
}

/**
 * Parse one SSE `data:` line. Uses the native fast path when available.
 */
export function parseSseDataLine(line: string): unknown | typeof SSE_DONE | null {
  const n = loadNativeSse();
  if (n) {
    const r = n.parseSseDataLine(line);
    if (r.isDone) return SSE_DONE;
    if (r.payload === null) return null;
    try {
      return JSON.parse(r.payload) as unknown;
    } catch {
      return null;
    }
  }

  return parseSseDataLineCore(line);
}
