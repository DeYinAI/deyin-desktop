/**
 * Persistent response cache with embedding similarity.
 * Uses a JSON file store (lightweight, no native dependencies).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmbeddingService } from "./embeddings.js";
import { cosineSimilarity } from "./embeddings.js";

export interface CachedResponse {
  query: string;
  embedding: Float32Array;
  response: string;
  workspaceId: string;
  timestamp: number;
  useCount: number;
}

export interface ResponseCacheStats {
  size: number;
  hits: number;
  misses: number;
  semanticHits: number;
}

interface StoredRow {
  queryHash: string;
  queryText: string;
  embedding: number[];
  response: string;
  workspaceId: string;
  timestamp: number;
  useCount: number;
}

export class ResponseCache {
  private rows: StoredRow[] = [];
  private hits = 0;
  private misses = 0;
  private semanticHits = 0;
  private dirty = false;
  private readonly jsonPath: string;
  private readonly ttlMs: number;
  private similarityThreshold: number;
  private readonly maxEntries: number;

  constructor(
    dbPath: string,
    private readonly embeddings: EmbeddingService,
    opts?: { ttlMs?: number; similarityThreshold?: number; maxEntries?: number },
  ) {
    this.jsonPath = dbPath.endsWith(".db") ? dbPath.replace(/\.db$/, ".json") : `${dbPath}.json`;
    this.ttlMs = opts?.ttlMs ?? 15 * 60 * 1000;
    this.similarityThreshold = opts?.similarityThreshold ?? 0.93;
    this.maxEntries = opts?.maxEntries ?? 500;
  }

  async initialize(): Promise<void> {
    mkdirSync(dirname(this.jsonPath), { recursive: true });
    if (existsSync(this.jsonPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.jsonPath, "utf8")) as { rows?: StoredRow[] };
        this.rows = Array.isArray(raw.rows) ? raw.rows : [];
      } catch {
        this.rows = [];
      }
    }
  }

  /**
   * Atomic, debounced persist: writes to a sibling temp file then renames
   * it into place so concurrent callers (multiple agent runs / automations)
   * can't observe or corrupt a half-written store. The dirty flag is
   * cleared synchronously so re-entrant calls within the same tick coalesce.
   */
  private persist(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.jsonPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ rows: this.rows }, null, 0), "utf8");
    renameSync(tmp, this.jsonPath);
  }

  private hash(query: string): string {
    return createHash("sha256").update(query.trim().toLowerCase()).digest("hex").slice(0, 32);
  }

  private fresh(row: StoredRow): boolean {
    return Date.now() - row.timestamp <= this.ttlMs;
  }

  async get(query: string, workspaceId: string): Promise<CachedResponse | null> {
    const q = query.trim();
    if (!q) {
      this.misses += 1;
      return null;
    }

    const queryHash = this.hash(q);
    const exact = this.rows.find((r) => r.workspaceId === workspaceId && r.queryHash === queryHash && this.fresh(r));
    if (exact) {
      exact.useCount += 1;
      this.dirty = true;
      this.persist();
      this.hits += 1;
      return {
        query: exact.queryText,
        embedding: Float32Array.from(exact.embedding),
        response: exact.response,
        workspaceId: exact.workspaceId,
        timestamp: exact.timestamp,
        useCount: exact.useCount,
      };
    }

    const queryVec = await this.embeddings.embed(q, {
      instruction: "Given a developer question, retrieve a semantically equivalent prior answer",
    });

    let best: StoredRow | null = null;
    let bestScore = -1;
    for (const row of this.rows) {
      if (row.workspaceId !== workspaceId || !this.fresh(row)) continue;
      const score = cosineSimilarity(queryVec, Float32Array.from(row.embedding));
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }

    if (best && bestScore >= this.similarityThreshold) {
      best.useCount += 1;
      this.dirty = true;
      this.persist();
      this.hits += 1;
      this.semanticHits += 1;
      return {
        query: best.queryText,
        embedding: Float32Array.from(best.embedding),
        response: best.response,
        workspaceId: best.workspaceId,
        timestamp: best.timestamp,
        useCount: best.useCount,
      };
    }

    this.misses += 1;
    return null;
  }

  async set(query: string, response: string, workspaceId: string): Promise<void> {
    const q = query.trim();
    if (!q || !response.trim()) return;
    if (response.length > 200_000) return;

    // Use the SAME instruction as get() so stored/lookup embeddings live in
    // the same vector space — otherwise semantic hits silently never fire.
    const embedding = await this.embeddings.embed(q, {
      instruction: "Given a developer question, retrieve a semantically equivalent prior answer",
    });
    const queryHash = this.hash(q);
    this.rows = this.rows.filter((r) => !(r.workspaceId === workspaceId && r.queryHash === queryHash));
    this.rows.push({
      queryHash,
      queryText: q,
      embedding: Array.from(embedding),
      response,
      workspaceId,
      timestamp: Date.now(),
      useCount: 0,
    });

    if (this.rows.length > this.maxEntries) {
      this.rows.sort((a, b) => a.timestamp - b.timestamp);
      this.rows = this.rows.slice(this.rows.length - this.maxEntries);
    }
    this.dirty = true;
    this.persist();
  }

  invalidateWorkspace(workspaceId: string): void {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.workspaceId !== workspaceId);
    if (this.rows.length !== before) {
      this.dirty = true;
      this.persist();
    }
  }

  /** Drop all cached responses. Used by explicit "clear cache" actions. */
  clear(): void {
    if (this.rows.length === 0) return;
    this.rows = [];
    this.dirty = true;
    this.persist();
  }

  setSimilarityThreshold(threshold: number): void {
    this.similarityThreshold = threshold;
  }

  pruneOld(olderThan: Date): void {
    const cutoff = olderThan.getTime();
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.timestamp >= cutoff);
    if (this.rows.length !== before) {
      this.dirty = true;
      this.persist();
    }
  }

  getStats(): ResponseCacheStats {
    return {
      size: this.rows.length,
      hits: this.hits,
      misses: this.misses,
      semanticHits: this.semanticHits,
    };
  }

  close(): void {
    this.persist();
  }

  /** Path helpers for hosts that want a standard location under userData. */
  static paths(userData: string): { db: string; models: string } {
    return {
      db: join(userData, "plugins", "optimization", "caches", "responses.db"),
      models: join(userData, "plugins", "optimization", "models"),
    };
  }
}
