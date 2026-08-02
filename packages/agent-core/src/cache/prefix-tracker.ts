/**
 * Prefix stability tracking for DeepSeek-style cache optimization.
 * 
 * The cache key is the byte-identical prefix:
 * - System prompt (deterministic build)
 * - Tool schemas (sorted, canonicalized)
 * - Conversation history (grows append-only until compaction)
 * 
 * This module tracks what changed between requests to diagnose cache invalidation.
 */

import { createHash } from "crypto";
import type { AgentMessage } from "../types.js";

export interface PrefixShape {
  /** SHA-256 of the system prompt */
  systemHash: string;
  /** SHA-256 of sorted, canonicalized tool schemas */
  toolsHash: string;
  /** Combined prefix hash (system + tools) */
  prefixHash: string;
  /** Conversation rewrite version (bumped on compaction) */
  logRewriteVersion: number;
  /** Estimated tokens in tool schemas */
  toolSchemaTokens: number;
}

export interface CacheDiagnostics {
  /** Reasons for prefix invalidation */
  prefixChanged: boolean;
  changeReasons: Array<"system" | "tools" | "log_rewrite">;
  /** Cache hit/miss tokens this turn */
  hit: number;
  miss: number;
  /** Cache hit rate for this turn */
  hitRate: number;
}

/**
 * Compute a stable hash of the system prompt.
 * System prompt should be deterministically built from:
 * - Base agent prompt
 * - Memory index (if any)
 * - Skills summary
 * - Environment snapshot (cached, 24h TTL)
 * - Mode instructions
 */
export function hashSystemPrompt(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/** Recursively sort object keys for stable JSON serialization. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = canonicalize(obj[key]);
  return out;
}

/**
 * Serialize tool schemas to byte-stable JSON (sorted tool names + sorted keys).
 */
export function canonicalizeToolSchemas(schemas: readonly unknown[]): string {
  const asRecords = schemas as Record<string, unknown>[];
  const sorted = [...asRecords].sort((a, b) => {
    const nameA = (a.function as { name?: string })?.name ?? "";
    const nameB = (b.function as { name?: string })?.name ?? "";
    return nameA.localeCompare(nameB);
  });
  return JSON.stringify(canonicalize(sorted));
}

/**
 * Compute a stable hash of tool schemas.
 * Tools must be sorted by name and canonicalized (stable JSON key order)
 * so identical logical toolsets produce identical bytes.
 */
export function hashToolSchemas(schemas: readonly unknown[]): string {
  const canonical = canonicalizeToolSchemas(schemas);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/**
 * Returns true when compaction mutated the transcript prefix (loop bumps logRewriteVersion).
 */
export function shouldBumpLogRewriteVersion(compaction: {
  droppedMessages: number;
  truncatedToolResults: number;
  truncatedToolArgs: number;
}): boolean {
  return (
    compaction.droppedMessages > 0 ||
    compaction.truncatedToolResults > 0 ||
    compaction.truncatedToolArgs > 0
  );
}

/**
 * Build a prefix shape snapshot for cache diagnostics.
 */
export function computePrefixShape(
  systemMessage: AgentMessage | undefined,
  toolSchemas: readonly unknown[],
  logRewriteVersion: number,
  toolSchemaTokens: number
): PrefixShape {
  const systemHash = systemMessage?.content 
    ? hashSystemPrompt(systemMessage.content)
    : "0".repeat(16);
  const toolsHash = hashToolSchemas(toolSchemas);
  
  // Prefix hash combines both stable components
  const prefixHash = createHash("sha256")
    .update(systemHash + toolsHash, "utf8")
    .digest("hex")
    .slice(0, 16);
  
  return {
    systemHash,
    toolsHash,
    prefixHash,
    logRewriteVersion,
    toolSchemaTokens,
  };
}

/**
 * Compare two prefix shapes and identify what changed.
 */
export function comparePrefixShapes(
  prev: PrefixShape | undefined,
  current: PrefixShape,
  cacheHit: number,
  cacheMiss: number
): CacheDiagnostics {
  if (!prev) {
    return {
      prefixChanged: false,
      changeReasons: [],
      hit: cacheHit,
      miss: cacheMiss,
      hitRate: cacheMiss === 0 ? 1 : cacheHit / (cacheHit + cacheMiss),
    };
  }
  
  const reasons: Array<"system" | "tools" | "log_rewrite"> = [];
  
  if (prev.systemHash !== current.systemHash) {
    reasons.push("system");
  }
  
  if (prev.toolsHash !== current.toolsHash) {
    reasons.push("tools");
  }
  
  if (prev.logRewriteVersion !== current.logRewriteVersion) {
    reasons.push("log_rewrite");
  }
  
  return {
    prefixChanged: reasons.length > 0,
    changeReasons: reasons,
    hit: cacheHit,
    miss: cacheMiss,
    hitRate: cacheMiss === 0 ? 1 : cacheHit / (cacheHit + cacheMiss),
  };
}

/**
 * Compute a stable prompt cache key including tool hash.
 * OpenAI/Openference use this key to match cached prefixes across requests.
 */
export function buildPromptCacheKey(
  model: string,
  mode: string,
  systemHash: string,
  toolsHash: string
): string {
  return `deyin:${model}:${mode}:${systemHash}:${toolsHash}`;
}
