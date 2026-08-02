/**
 * Backfill existing session files to v2 metadata (prefix_hash, cache_stats).
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computePrefixShape } from "../cache/prefix-tracker.js";
import type { AgentMessage } from "../types.js";
import {
  buildCacheStats,
  migrateSessionMeta,
  SESSION_SCHEMA_VERSION,
  sessionNeedsMigration,
  type SessionMetaRecord,
} from "./session-v2.js";

type SessionRecord =
  | { type: "meta"; meta: SessionMetaRecord }
  | { type: "message"; message: AgentMessage };

export interface BackfillResult {
  sessionId: string;
  migrated: boolean;
  prefixHash?: string;
  error?: string;
}

export interface BackfillSummary {
  total: number;
  migrated: number;
  skipped: number;
  errors: BackfillResult[];
}

function estimateToolSchemaTokens(toolCount: number): number {
  return toolCount * 50;
}

/**
 * Recompute prefix_hash and seed cache_stats from transcript when missing.
 * Does not mutate messages — only upgrades the meta record.
 */
export function backfillSessionFile(filePath: string, opts?: { dryRun?: boolean }): BackfillResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return {
      sessionId: filePath,
      migrated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) {
    return { sessionId: filePath, migrated: false, error: "empty file" };
  }

  let metaLineIndex = -1;
  let metaRaw: unknown;
  const messages: AgentMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const record = JSON.parse(lines[i]!) as SessionRecord;
      if (record.type === "meta") {
        metaLineIndex = i;
        metaRaw = record.meta;
      } else if (record.type === "message") {
        messages.push(record.message);
      }
    } catch {
      // skip corrupt lines
    }
  }

  if (metaLineIndex < 0) {
    return { sessionId: filePath, migrated: false, error: "no meta record" };
  }

  const needsMigration = sessionNeedsMigration(metaRaw);
  const meta = migrateSessionMeta(metaRaw);

  const systemMsg = messages.find((m) => m.role === "system");
  const toolCallCount = messages.filter((m) => m.role === "assistant" && "toolCalls" in m && m.toolCalls?.length).length;
  const toolCount = Math.max(8, Math.min(24, 8 + toolCallCount));

  const tools = Array.from({ length: toolCount }, (_, j) => ({
    type: "function" as const,
    function: { name: `tool_${j}`, description: "d", parameters: { type: "object", properties: {} } },
  }));

  const shape = computePrefixShape(systemMsg, tools, meta.cacheStats?.logRewriteVersion ?? 0, estimateToolSchemaTokens(toolCount));

  let changed = needsMigration;
  if (!meta.prefixHash) {
    meta.prefixHash = shape.prefixHash;
    changed = true;
  }
  if (!meta.cacheStats) {
    meta.cacheStats = buildCacheStats({ sessionCacheHit: 0, sessionCacheMiss: 0 }, shape);
    changed = true;
  }

  meta.schemaVersion = SESSION_SCHEMA_VERSION;

  if (!changed) {
    return { sessionId: meta.id || filePath, migrated: false, prefixHash: meta.prefixHash };
  }

  if (!opts?.dryRun) {
    lines[metaLineIndex] = JSON.stringify({ type: "meta", meta });
    writeFileSync(filePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }

  return { sessionId: meta.id, migrated: true, prefixHash: meta.prefixHash };
}

/** Backfill every *.jsonl session in a directory. */
export function backfillSessionDirectory(sessionsDir: string, opts?: { dryRun?: boolean }): BackfillSummary {
  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { total: 0, migrated: 0, skipped: 0, errors: [] };
  }

  const summary: BackfillSummary = { total: files.length, migrated: 0, skipped: 0, errors: [] };

  for (const file of files) {
    const result = backfillSessionFile(join(sessionsDir, file), opts);
    if (result.error) summary.errors.push(result);
    else if (result.migrated) summary.migrated += 1;
    else summary.skipped += 1;
  }

  return summary;
}

/** Roll back v2 meta to v1 shape (for upgrade → rollback → upgrade tests). */
export function stripSessionV2Meta(meta: SessionMetaRecord): Omit<SessionMetaRecord, "schemaVersion" | "prefixHash" | "cacheStats"> {
  const { schemaVersion: _sv, prefixHash: _ph, cacheStats: _cs, ...rest } = meta;
  return rest;
}
