/**
 * Native hot-path loader with transparent TS fallbacks.
 *
 * When @deyin/native-core's .node binary is present (and built for this
 * platform), the native implementations run; otherwise every call degrades
 * gracefully to the pure-TS versions. Callers never branch on availability.
 *
 * Loading is synchronous (createRequire works from ESM) so the hot paths —
 * wire compression inside stream serialization — can stay synchronous.
 */
import { createRequire } from "node:module";
import { countTokensTs, truncateToTokensTs } from "./tokenizer-ts.js";

export interface NativeGrepHit {
  file: string;
  lineNumber: number;
  lineText: string;
}

interface NativeCore {
  available: boolean;
  countTokens(text: string): number | null;
  truncateToTokens(text: string, max: number): string | null;
  compressWireText(content: string, mode: string):
    | { compressed: string; originalChars: number; compressedChars: number }
    | null;
  compressWireTextEx?(
    content: string,
    mode: string,
    toolName: string,
    preserveErrors: boolean,
  ): { compressed: string; originalChars: number; compressedChars: number } | null;
  grep(
    root: string,
    pattern: string,
    glob?: string,
    maxResults?: number,
    ignoreCase?: boolean,
  ): { matches: NativeGrepHit[]; truncated: boolean } | null;
}

let cached: NativeCore | null | undefined;

function loadNative(): NativeCore | null {
  if (cached !== undefined) return cached;
  try {
    const mod = createRequire(import.meta.url)("@deyin/native-core") as unknown as NativeCore;
    cached = mod?.available ? mod : null;
  } catch {
    cached = null; // not installed / not built / wrong platform
  }
  return cached;
}

export function nativeAvailable(): boolean {
  return loadNative() !== null;
}

export function fastCountTokens(text: string): number {
  const n = loadNative();
  if (n) {
    const r = n.countTokens(text);
    if (r !== null && r !== undefined) return r;
  }
  return countTokensTs(text);
}

export function fastTruncateToTokens(text: string, maxTokens: number): string {
  const n = loadNative();
  if (n) {
    const r = n.truncateToTokens(text, maxTokens);
    if (r !== null && r !== undefined) return r;
  }
  return truncateToTokensTs(text, maxTokens);
}

/**
 * Wire compression via the native port of compressToolOutput. Returns the
 * compressed text, or null when the module is unavailable/failed (caller then
 * uses the TS implementation).
 */
export function fastCompressToolOutput(
  content: string,
  mode: "aggressive" | "balanced" | "conservative",
  toolName = "tool",
  preserveErrors = false,
): string | null {
  const n = loadNative();
  if (!n || typeof n.compressWireTextEx !== "function") return null;
  try {
    const r = n.compressWireTextEx(content, mode, toolName, preserveErrors);
    return r?.compressed ?? null;
  } catch {
    return null;
  }
}

/** Native in-process grep; null when unavailable or on search errors. */
export function nativeGrep(
  root: string,
  pattern: string,
  glob?: string,
  maxResults?: number,
  ignoreCase = false,
): { matches: NativeGrepHit[]; truncated: boolean } | null {
  const n = loadNative();
  if (!n) return null;
  try {
    return n.grep(root, pattern, glob, maxResults, ignoreCase);
  } catch {
    return null;
  }
}
