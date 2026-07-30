/**
 * In-memory LRU tool-result cache with optional semantic matching via embeddings.
 */

import { createHash } from "node:crypto";
import type { EmbeddingService } from "./embeddings.js";
import { cosineSimilarity } from "./embeddings.js";

export interface CacheConfig {
  maxSize: number;
  similarityThreshold: number;
  enableSemanticMatch: boolean;
  /** Per-tool TTL in ms. Tools not listed use defaultTtlMs. */
  perToolTTL?: Record<string, number>;
  defaultTtlMs?: number;
  /** Tools that should never be cached, applied as an additional deny on top of CACHEABLE_TOOLS. */
  neverCache?: string[];
}

export interface CacheEntry {
  key: string;
  toolName: string;
  argsFingerprint: string;
  embedding?: Float32Array;
  result: string;
  timestamp: number;
  hitCount: number;
  ttl: number;
  /** File paths referenced in args (for invalidation after edits). */
  paths?: string[];
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  semanticHits: number;
  evictions: number;
}

/**
 * Allowlist of tools safe to cache results for. Side-effecting tools,
 * MCP tools, and the task subagent tool are denied by default — only
 * idempotent read/search/inspection tools qualify.
 */
const CACHEABLE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "codebase_search",
  "websearch",
  "browser_snapshot",
  "browser_screenshot",
  "browser_console",
  "browser_network",
]);

const DEFAULT_TTL: Record<string, number> = {
  read: 60_000,
  grep: 30_000,
  glob: 30_000,
  ls: 20_000,
  codebase_search: 45_000,
  websearch: 120_000,
  browser_snapshot: 30_000,
  browser_screenshot: 30_000,
  browser_console: 15_000,
  browser_network: 30_000,
};

/** Pull filesystem paths out of common tool args shapes. */
function extractPaths(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const a = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["path", "file", "file_path", "filePath", "directory", "dir", "folder"]) {
    const v = a[key];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  // grep/glob accept arrays of paths via path/glob/include/exclude.
  for (const key of ["paths", "include", "exclude", "globs"]) {
    const v = a[key];
    if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string" && item.length > 0) out.push(item);
    }
  }
  return out;
}

function normalizeCachePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase().replace(/^\.\//, "");
}

export class ToolResultCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly order: string[] = [];
  private hits = 0;
  private misses = 0;
  private semanticHits = 0;
  private evictions = 0;

  constructor(
    private readonly config: CacheConfig,
    private readonly embeddings?: EmbeddingService,
  ) {}

  private ttlFor(toolName: string): number {
    return this.config.perToolTTL?.[toolName] ?? DEFAULT_TTL[toolName] ?? this.config.defaultTtlMs ?? 30_000;
  }

private shouldCache(toolName: string): boolean {
 if (!CACHEABLE_TOOLS.has(toolName)) return false;
 const never = this.config.neverCache;
 return !never || !never.includes(toolName);
 }

  private fingerprint(toolName: string, args: unknown): string {
    const raw = JSON.stringify({ toolName, args });
    return createHash("sha256").update(raw).digest("hex").slice(0, 32);
  }

  private touch(key: string): void {
    const idx = this.order.indexOf(key);
    if (idx >= 0) this.order.splice(idx, 1);
    this.order.push(key);
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.config.maxSize && this.order.length > 0) {
      const oldest = this.order.shift()!;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
  }

  private isFresh(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp <= entry.ttl;
  }

  async get(toolName: string, args: unknown): Promise<CacheEntry | null> {
    if (!this.shouldCache(toolName)) {
      this.misses += 1;
      return null;
    }

    const key = this.fingerprint(toolName, args);
    const exact = this.entries.get(key);
    if (exact && this.isFresh(exact)) {
      exact.hitCount += 1;
      this.touch(key);
      this.hits += 1;
      return exact;
    }
    if (exact) this.entries.delete(key);

    if (this.config.enableSemanticMatch && this.embeddings) {
      const queryText = `${toolName} ${JSON.stringify(args)}`;
      const queryVec = await this.embeddings.embed(queryText, {
        instruction: "Given a tool invocation, retrieve a semantically equivalent prior tool call",
      });
      let best: CacheEntry | null = null;
      let bestScore = -1;
      for (const entry of this.entries.values()) {
        if (entry.toolName !== toolName || !entry.embedding || !this.isFresh(entry)) continue;
        const score = cosineSimilarity(queryVec, entry.embedding);
        if (score > bestScore) {
          bestScore = score;
          best = entry;
        }
      }
      if (best && bestScore >= this.config.similarityThreshold) {
        best.hitCount += 1;
        this.touch(best.key);
        this.hits += 1;
        this.semanticHits += 1;
        return best;
      }
    }

    this.misses += 1;
    return null;
  }

  async set(toolName: string, args: unknown, result: string, ttl?: number): Promise<void> {
    if (!this.shouldCache(toolName)) return;
    if (result.startsWith("ERROR:") || result.startsWith("Denied:")) return;

const key = this.fingerprint(toolName, args);
 let embedding: Float32Array | undefined;
 if (this.config.enableSemanticMatch && this.embeddings) {
 // Match the instruction used by get() so stored/lookup vectors share space.
 embedding = await this.embeddings.embed(`${toolName} ${JSON.stringify(args)}`, {
 instruction: "Given a tool invocation, retrieve a semantically equivalent prior tool call",
 });
 }

const entry: CacheEntry = {
 key,
 toolName,
 argsFingerprint: key,
 embedding,
 result,
 timestamp: Date.now(),
 hitCount: 0,
 ttl: ttl ?? this.ttlFor(toolName),
 paths: extractPaths(args),
 };
    this.entries.set(key, entry);
    this.touch(key);
    this.evictIfNeeded();
  }

  invalidate(predicate: (entry: CacheEntry) => boolean): void {
    for (const [key, entry] of this.entries) {
      if (predicate(entry)) {
        this.entries.delete(key);
        const idx = this.order.indexOf(key);
        if (idx >= 0) this.order.splice(idx, 1);
      }
    }
  }

/** Invalidate cached reads/searches that mention a path (after file edits). */
  invalidatePath(path: string): void {
    const needle = normalizeCachePath(path);
    if (!needle) return;
    this.invalidate((e) =>
      e.paths?.some((p) => {
        const stored = normalizeCachePath(p);
        if (!stored) return false;
        // Prefer exact / suffix match to avoid "auth.ts" matching "not-auth.ts".
        return stored === needle || stored.endsWith(`/${needle}`) || needle.endsWith(`/${stored}`);
      }) ?? false,
    );
  }

  clear(): void {
    this.entries.clear();
    this.order.length = 0;
  }

  setSimilarityThreshold(threshold: number): void {
    this.config.similarityThreshold = threshold;
  }

  getStats(): CacheStats {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      semanticHits: this.semanticHits,
      evictions: this.evictions,
    };
  }
}
