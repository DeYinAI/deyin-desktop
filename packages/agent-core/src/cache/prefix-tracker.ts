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

/**
 * Why a cached prefix stopped matching. `system` and `tools` are derived from
 * the hashes; the rest are the provider-visible transcript rewrites the run
 * reports as it makes them.
 */
export type CacheChangeReason = "system" | "tools" | "prune" | "fold" | "overflow";

export interface CacheDiagnostics {
  /** Reasons for prefix invalidation */
  prefixChanged: boolean;
  changeReasons: CacheChangeReason[];
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
/**
 * Compare two prefix shapes and identify what changed.
 *
 * `rewriteReasons` is the set of provider-visible transcript rewrites drained
 * since `prev` was captured. It is the ONLY source of rewrite-caused reasons: a
 * bare `logRewriteVersion` bump with no drained reason means something local-only
 * moved (a UI annotation, a resolved tool-call preview) which never reaches the
 * provider, so reporting it as a cache change is a false positive that sends
 * anyone debugging a low hit rate chasing the wrong thing.
 */
export function comparePrefixShapes(
  prev: PrefixShape | undefined,
  current: PrefixShape,
  cacheHit: number,
  cacheMiss: number,
  rewriteReasons: readonly CacheChangeReason[] = []
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
  
  const reasons: CacheChangeReason[] = [];
  
  if (prev.systemHash !== current.systemHash) {
    reasons.push("system");
  }
  
  if (prev.toolsHash !== current.toolsHash) {
    reasons.push("tools");
  }
  
  for (const reason of rewriteReasons) {
    if (!reasons.includes(reason)) reasons.push(reason);
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
