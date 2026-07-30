/**
 * Lightweight, dependency-free content compression for LLM payloads.
 * Strips noise from code, tool outputs, JSON and prose before wire serialization.
 */

export type CompressionMode = "aggressive" | "balanced" | "conservative";
export type ContentType = "code" | "log" | "json" | "text";

export interface CompressionOptions {
  mode?: CompressionMode;
  preserveCode?: boolean;
  preserveErrors?: boolean;
  maxLength?: number;
}

export interface CompressionMetadata {
  contentType: ContentType;
  mode: CompressionMode;
}

export interface CompressionResult {
  original: string;
  compressed: string;
  ratio: number;
  tokensRemoved: number;
  metadata: CompressionMetadata;
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/[^\n]*/gm;
const HASH_COMMENT_RE = /(^|\s)#(?!!).*$/gm;
const PREPROCESSOR_RE = /^\s*#\s*(include|define|ifdef|ifndef|endif|pragma|import|if|else|elif|undef|error|warning|line)\b/;
const MULTI_BLANK_RE = /\n{3,}/g;
const MULTI_SPACE_RE = /[ \t]{2,}/g;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*/gm;
const ISO_PREFIX_RE = /^\[[\d:.]+\]\s*/gm;

const ERROR_HINT_RE = /\b(error|exception|failed|fatal|panic|traceback|enoent|eacces|denied)\b/i;

function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

function result(original: string, compressed: string, contentType: ContentType, mode: CompressionMode): CompressionResult {
  // Algorithms may briefly expand (e.g. "N duplicate lines omitted"); only reject
  // pathological blow-ups, not useful short outputs that gained a marker.
  const final = compressed.length > original.length * 1.5 && compressed.length > original.length + 80 ? original : compressed;
  return {
    original,
    compressed: final,
    ratio: original.length === 0 ? 1 : final.length / original.length,
    tokensRemoved: Math.max(0, estimateTokens(original) - estimateTokens(final)),
    metadata: { contentType, mode },
  };
}

function capsFor(mode: CompressionMode): { maxLine: number; maxTotal: number; keepLogRatio: number } {
  switch (mode) {
    case "aggressive":
      return { maxLine: 240, maxTotal: 8_000, keepLogRatio: 0.25 };
    case "conservative":
      return { maxLine: 800, maxTotal: 40_000, keepLogRatio: 0.6 };
    default:
      return { maxLine: 480, maxTotal: 20_000, keepLogRatio: 0.4 };
  }
}

/** Heuristic content-type detector. */
export function detectContentType(content: string): ContentType {
  const trimmed = content.trim();
  if (!trimmed) return "text";
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // fall through
    }
  }
  // Reset sticky state: ANSI_RE is global and shared across calls.
  ANSI_RE.lastIndex = 0;
  if (ANSI_RE.test(content) || /^(PASS|FAIL|ERROR|WARN|INFO|DEBUG)\b/m.test(content) || /npm (err|warn)/i.test(content)) {
    ANSI_RE.lastIndex = 0;
    return "log";
  }
  ANSI_RE.lastIndex = 0;
  const codeSignals =
    /^(import |export |function |class |const |let |var |def |package |using |#include )/m.test(content) ||
    /[{};]\s*$/m.test(content) ||
    /\b(async|await|return|interface|type)\b/.test(content);
  if (codeSignals) return "code";
  return "text";
}

export function compressCode(code: string, options: CompressionOptions = {}): CompressionResult {
  const mode = options.mode ?? "balanced";
  if (options.preserveCode) return result(code, code, "code", mode);

let out = code.replace(BLOCK_COMMENT_RE, "");
 out = out.replace(LINE_COMMENT_RE, "$1");
 if (mode !== "conservative") {
 // Only strip hash comments that are NOT preprocessor directives
 out = out.split("\n").map((line) => PREPROCESSOR_RE.test(line) ? line : line.replace(HASH_COMMENT_RE, "$1")).join("\n");
 }
  out = out.replace(MULTI_BLANK_RE, "\n\n");
  if (mode === "aggressive") out = out.replace(MULTI_SPACE_RE, " ");

  const caps = capsFor(mode);
  if (out.length > caps.maxTotal) {
    out = `${out.slice(0, caps.maxTotal)}\n… [code truncated]`;
  }
  return result(code, out.trim(), "code", mode);
}

export function compressJSON(json: string, options: CompressionOptions = {}): CompressionResult {
  const mode = options.mode ?? "balanced";
  try {
    const parsed = JSON.parse(json) as unknown;
    const cleaned = mode === "conservative" ? parsed : stripNulls(parsed);
    const out = JSON.stringify(cleaned);
    return result(json, out, "json", mode);
  } catch {
    return result(json, json.replace(MULTI_SPACE_RE, " ").trim(), "json", mode);
  }
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isInteger(value)) {
    return Math.round(value * 1000) / 1000;
  }
  return value;
}

export function compressToolOutput(output: string, toolName: string, options: CompressionOptions = {}): CompressionResult {
  const mode = options.mode ?? "balanced";
  const caps = capsFor(mode);
  let text = output.replace(ANSI_RE, "");
  text = text.replace(TIMESTAMP_RE, "").replace(ISO_PREFIX_RE, "");

  const lines = text.split("\n");
  const deduped: string[] = [];
  let prev = "";
  let repeat = 0;
  for (const line of lines) {
    const normalized = line.replace(MULTI_SPACE_RE, " ").trimEnd();
    if (normalized === prev) {
      repeat += 1;
      continue;
    }
    if (repeat > 0) {
      deduped.push(`… (${repeat} duplicate line${repeat === 1 ? "" : "s"} omitted)`);
      repeat = 0;
    }
    prev = normalized;
    if (normalized.length > caps.maxLine) {
      deduped.push(`${normalized.slice(0, caps.maxLine)}…`);
    } else {
      deduped.push(normalized);
    }
  }
  if (repeat > 0) deduped.push(`… (${repeat} duplicate line${repeat === 1 ? "" : "s"} omitted)`);

  // Prefer error/warning lines for noisy logs from bash/exec tools.
  const isNoisy = /bash|shell|exec|terminal|npm|pnpm|yarn|pytest|jest/i.test(toolName) || detectContentType(output) === "log";
  let kept = deduped;
  if (isNoisy && mode !== "conservative" && deduped.length > 40) {
    const important = deduped.filter((l) => ERROR_HINT_RE.test(l));
    const budget = Math.max(20, Math.floor(deduped.length * caps.keepLogRatio));
    if (important.length > 0 && (options.preserveErrors || important.length < budget)) {
      // When preserveErrors is set, keep all error lines then fill remaining budget
      // with recent non-error lines — never treat every line as "important".
      const keepErrors = options.preserveErrors ? important : important.slice(0, budget);
      const filler = deduped
        .filter((l) => !ERROR_HINT_RE.test(l))
        .slice(-Math.max(0, budget - keepErrors.length));
      kept = [...keepErrors, ...filler];
    } else {
      kept = deduped.slice(-budget);
    }
  }

  let out = kept.join("\n").replace(MULTI_BLANK_RE, "\n\n").trim();
  if (out.length > caps.maxTotal) out = `${out.slice(0, caps.maxTotal)}\n… [tool output truncated]`;
  return result(output, out, isNoisy ? "log" : detectContentType(output), mode);
}

export function compressMessage(message: string, options: CompressionOptions = {}): CompressionResult {
  const mode = options.mode ?? "balanced";
  const type = detectContentType(message);
  switch (type) {
    case "code":
      return compressCode(message, options);
    case "json":
      return compressJSON(message, options);
    case "log":
      return compressToolOutput(message, "log", options);
    default: {
      let out = message.replace(MULTI_BLANK_RE, "\n\n").replace(MULTI_SPACE_RE, " ").trim();
      const max = options.maxLength ?? capsFor(mode).maxTotal;
      if (mode === "aggressive") out = extractiveCompress(out, max);
      else if (out.length > max) out = `${out.slice(0, max)}\n… [truncated]`;
      return result(message, out, "text", mode);
    }
  }
}

/** Keep sentences with higher lexical novelty (cheap TF-IDF-ish scoring). */
function extractiveCompress(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length <= 2) return text.slice(0, maxLength);

  const df = new Map<string, number>();
  const tokenized = sentences.map((s) => {
    const toks = s.toLowerCase().split(/[^a-z0-9_./-]+/).filter((t) => t.length > 2);
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    return toks;
  });

  const scored = sentences.map((s, i) => {
    const toks = tokenized[i]!;
    let score = 0;
    for (const t of toks) {
      const freq = df.get(t) ?? 1;
      score += 1 / freq;
      if (ERROR_HINT_RE.test(t) || /[./\\]/.test(t)) score += 1.5;
    }
    // Prefer later sentences slightly (recency).
    score += i / sentences.length;
    return { s, score, i };
  });

  scored.sort((a, b) => b.score - a.score);
  const chosen = new Set<number>();
  let len = 0;
  for (const item of scored) {
    if (len + item.s.length > maxLength && chosen.size > 0) break;
    chosen.add(item.i);
    len += item.s.length + 1;
  }
  return sentences.filter((_, i) => chosen.has(i)).join(" ");
}

export class ContentCompressor {
  constructor(private readonly defaults: CompressionOptions = { mode: "balanced" }) {}

  compressCode(code: string, options?: CompressionOptions): CompressionResult {
    return compressCode(code, { ...this.defaults, ...options });
  }

  compressToolOutput(output: string, toolName: string, options?: CompressionOptions): CompressionResult {
    return compressToolOutput(output, toolName, { ...this.defaults, ...options });
  }

  compressJSON(json: string, options?: CompressionOptions): CompressionResult {
    return compressJSON(json, { ...this.defaults, ...options });
  }

  compressMessage(message: string, options?: CompressionOptions): CompressionResult {
    return compressMessage(message, { ...this.defaults, ...options });
  }

  detectContentType(content: string): ContentType {
    return detectContentType(content);
  }
}
