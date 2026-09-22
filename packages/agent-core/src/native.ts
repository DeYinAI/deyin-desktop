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
  frameAcpChunk?(buffer: string, chunk: string): { payloads: string[]; rest: string } | null;
  isJsonRpc?(line: string): boolean | null;
  frameNdjsonChunk?(buffer: string, chunk: string): { lines: string[]; rest: string } | null;
  ringBufferAppend?(bufferId: string, line: string, capacity?: number | null): void;
  ringBufferGetLines?(bufferId: string, maxLines?: number | null): string[] | null;
  ringBufferClear?(bufferId: string): void;
  ringBufferRemove?(bufferId: string): void;
  watchdogRegister?(id: string, pid: number, timeoutMs: number, stallThresholdMs: number, nowMs?: number | null): void;
  watchdogHeartbeat?(id: string, nowMs?: number | null): boolean | null;
  watchdogCheck?(id: string, nowMs?: number | null): { status: string; elapsedMs: number; inactiveMs: number } | null;
  watchdogUnregister?(id: string): boolean | null;
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

// In-memory fallbacks for non-native / test environments
const tsRingBuffers = new Map<string, string[]>();
interface TsWatchdogEntry {
  pid: number;
  timeoutMs: number;
  stallThresholdMs: number;
  startedAtMs: number;
  lastActivityMs: number;
}
const tsWatchdogs = new Map<string, TsWatchdogEntry>();

export function fastFrameAcpChunk(buffer: string, chunk: string): { payloads: string[]; rest: string } {
  const n = loadNative();
  if (n && typeof n.frameAcpChunk === "function") {
    try {
      const res = n.frameAcpChunk(buffer, chunk);
      if (res) return res;
    } catch {}
  }
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  const rest = parts.pop() ?? "";
  const payloads = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  return { payloads, rest };
}

export function fastFrameNdjsonChunk(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const n = loadNative();
  if (n && typeof n.frameNdjsonChunk === "function") {
    try {
      const res = n.frameNdjsonChunk(buffer, chunk);
      if (res) return res;
    } catch {}
  }
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  const rest = parts.pop() ?? "";
  const lines = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  return { lines, rest };
}

export function fastRingBufferAppend(bufferId: string, line: string, capacity = 10_000): void {
  const n = loadNative();
  if (n && typeof n.ringBufferAppend === "function") {
    try {
      n.ringBufferAppend(bufferId, line, capacity);
      return;
    } catch {}
  }
  let buf = tsRingBuffers.get(bufferId);
  if (!buf) {
    buf = [];
    tsRingBuffers.set(bufferId, buf);
  }
  if (buf.length >= capacity) buf.shift();
  buf.push(line);
}

export function fastRingBufferGetLines(bufferId: string, maxLines?: number): string[] {
  const n = loadNative();
  if (n && typeof n.ringBufferGetLines === "function") {
    try {
      const res = n.ringBufferGetLines(bufferId, maxLines ?? null);
      if (res) return res;
    } catch {}
  }
  const buf = tsRingBuffers.get(bufferId) ?? [];
  if (maxLines && buf.length > maxLines) {
    return buf.slice(buf.length - maxLines);
  }
  return [...buf];
}

export function fastRingBufferClear(bufferId: string): void {
  const n = loadNative();
  if (n) {
    try {
      if (typeof n.ringBufferRemove === "function") {
        n.ringBufferRemove(bufferId);
      } else if (typeof n.ringBufferClear === "function") {
        n.ringBufferClear(bufferId);
      }
    } catch {}
  }
  tsRingBuffers.delete(bufferId);
}

export function fastRingBufferRemove(bufferId: string): void {
  fastRingBufferClear(bufferId);
}

export interface WatchdogStatusResult {
  status: "running" | "stalled" | "timed-out" | "not-found";
  elapsedMs: number;
  inactiveMs: number;
}

export function fastWatchdogRegister(
  id: string,
  pid: number,
  timeoutMs: number,
  stallThresholdMs: number,
  nowMs = Date.now(),
): void {
  const n = loadNative();
  if (n && typeof n.watchdogRegister === "function") {
    try {
      n.watchdogRegister(id, pid, timeoutMs, stallThresholdMs, nowMs);
      return;
    } catch {}
  }
  tsWatchdogs.set(id, {
    pid,
    timeoutMs,
    stallThresholdMs,
    startedAtMs: nowMs,
    lastActivityMs: nowMs,
  });
}

export function fastWatchdogHeartbeat(id: string, nowMs = Date.now()): boolean {
  const n = loadNative();
  if (n && typeof n.watchdogHeartbeat === "function") {
    try {
      const res = n.watchdogHeartbeat(id, nowMs);
      if (typeof res === "boolean") return res;
    } catch {}
  }
  const entry = tsWatchdogs.get(id);
  if (!entry) return false;
  entry.lastActivityMs = nowMs;
  return true;
}

export function fastWatchdogCheck(id: string, nowMs = Date.now()): WatchdogStatusResult {
  const n = loadNative();
  if (n && typeof n.watchdogCheck === "function") {
    try {
      const res = n.watchdogCheck(id, nowMs);
      if (res) {
        return {
          status: res.status as WatchdogStatusResult["status"],
          elapsedMs: res.elapsedMs,
          inactiveMs: res.inactiveMs,
        };
      }
    } catch {}
  }
  const entry = tsWatchdogs.get(id);
  if (!entry) {
    return { status: "not-found", elapsedMs: 0, inactiveMs: 0 };
  }
  const elapsedMs = Math.max(0, nowMs - entry.startedAtMs);
  const inactiveMs = Math.max(0, nowMs - entry.lastActivityMs);
  if (entry.timeoutMs > 0 && elapsedMs >= entry.timeoutMs) {
    return { status: "timed-out", elapsedMs, inactiveMs };
  }
  if (entry.stallThresholdMs > 0 && inactiveMs >= entry.stallThresholdMs) {
    return { status: "stalled", elapsedMs, inactiveMs };
  }
  return { status: "running", elapsedMs, inactiveMs };
}

export function fastWatchdogUnregister(id: string): boolean {
  const n = loadNative();
  if (n && typeof n.watchdogUnregister === "function") {
    try {
      const res = n.watchdogUnregister(id);
      if (typeof res === "boolean") return res;
    } catch {}
  }
  return tsWatchdogs.delete(id);
}
