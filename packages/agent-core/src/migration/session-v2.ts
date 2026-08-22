/**
 * Session format v2 — adds prefix_hash and cache_stats to session metadata.
 */

import type { PrefixShape } from "../cache/prefix-tracker.js";
import type { OptimizationMetrics } from "../optimization.js";

/** Bump when SessionMetaV2 changes shape. */
export const SESSION_SCHEMA_VERSION = 2;

export interface SessionCacheStats {
  sessionCacheHit: number;
  sessionCacheMiss: number;
  hitRate: number;
  logRewriteVersion: number;
  lastUpdated: string;
}

/** Base session metadata shared by v1 and v2. */
export interface SessionMetaBase {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  agent: string;
  messageCount: number;
}

/** v2 session metadata (backward-compatible with v1). */
export interface SessionMetaV2 extends SessionMetaBase {
  schemaVersion: number;
  prefixHash?: string;
  cacheStats?: SessionCacheStats;
  /** Set when this session was forked from another; the log carries the full event. */
  forkedFrom?: string;
}

export type SessionMetaRecord = Omit<SessionMetaV2, "updatedAt" | "messageCount">;

function clampHitRate(hit: number, miss: number): number {
  const total = hit + miss;
  return total === 0 ? 1 : hit / total;
}

/** Build cache stats snapshot from optimization metrics and prefix shape. */
export function buildCacheStats(
  metrics: Pick<OptimizationMetrics, "sessionCacheHit" | "sessionCacheMiss">,
  prefixShape?: PrefixShape,
): SessionCacheStats {
  const hit = Math.max(0, metrics.sessionCacheHit);
  const miss = Math.max(0, metrics.sessionCacheMiss);
  return {
    sessionCacheHit: hit,
    sessionCacheMiss: miss,
    hitRate: clampHitRate(hit, miss),
    logRewriteVersion: prefixShape?.logRewriteVersion ?? 0,
    lastUpdated: new Date().toISOString(),
  };
}

/** Upgrade v1 session meta (no schemaVersion) to v2. */
export function migrateSessionMeta(raw: unknown): SessionMetaRecord {
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<SessionMetaRecord> & Record<string, unknown>;

  const base: SessionMetaRecord = {
    id: typeof input.id === "string" ? input.id : "",
    title: typeof input.title === "string" ? input.title : "",
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
    cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
    model: typeof input.model === "string" ? input.model : "GLM-5.2",
    agent: typeof input.agent === "string" ? input.agent : "build",
    schemaVersion: SESSION_SCHEMA_VERSION,
  };

  const forkedFrom = typeof input.forkedFrom === "string" ? input.forkedFrom : undefined;

  // Legacy snake_case from early agent experiments.
  const prefixHash =
    typeof input.prefixHash === "string"
      ? input.prefixHash
      : typeof input.prefix_hash === "string"
        ? input.prefix_hash
        : undefined;

  let cacheStats: SessionCacheStats | undefined;
  const rawStats = input.cacheStats ?? input.cache_stats;
  if (rawStats && typeof rawStats === "object") {
    const s = rawStats as Partial<SessionCacheStats>;
    const hit = typeof s.sessionCacheHit === "number" ? s.sessionCacheHit : 0;
    const miss = typeof s.sessionCacheMiss === "number" ? s.sessionCacheMiss : 0;
    cacheStats = {
      sessionCacheHit: hit,
      sessionCacheMiss: miss,
      hitRate: typeof s.hitRate === "number" ? s.hitRate : clampHitRate(hit, miss),
      logRewriteVersion: typeof s.logRewriteVersion === "number" ? s.logRewriteVersion : 0,
      lastUpdated: typeof s.lastUpdated === "string" ? s.lastUpdated : base.createdAt,
    };
  }

  if (prefixHash) base.prefixHash = prefixHash;
  if (cacheStats) base.cacheStats = cacheStats;
  if (forkedFrom) base.forkedFrom = forkedFrom;

  return base;
}

/** Invalidate cache stats when stored prefix hash disagrees with recomputed shape. */
export function invalidateCorruptedCacheStats(
  storedPrefixHash: string | undefined,
  recomputedPrefixHash: string,
  stats: SessionCacheStats | undefined,
): SessionCacheStats | undefined {
  if (!storedPrefixHash || storedPrefixHash === recomputedPrefixHash) return stats;
  return {
    sessionCacheHit: 0,
    sessionCacheMiss: stats?.sessionCacheMiss ?? 0,
    hitRate: 0,
    logRewriteVersion: stats?.logRewriteVersion ?? 0,
    lastUpdated: new Date().toISOString(),
  };
}

/** True when on-disk meta predates v2 and needs backfill. */
export function sessionNeedsMigration(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return true;
  const v = (raw as { schemaVersion?: number }).schemaVersion;
  return v == null || v < SESSION_SCHEMA_VERSION;
}
