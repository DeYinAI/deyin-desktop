import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computePrefixShape } from "./cache/prefix-tracker.js";
import {
  migrateSessionMeta,
  SESSION_SCHEMA_VERSION,
  sessionNeedsMigration,
  type SessionMetaRecord,
  type SessionMetaV2,
  buildCacheStats,
} from "./migration/session-v2.js";
import type { AgentMessage } from "./types.js";

export type SessionMeta = SessionMetaV2;

type SessionRecord = { type: "meta"; meta: SessionMetaRecord } | { type: "message"; message: AgentMessage };

function newId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Append-only JSONL transcripts, one file per session (<dir>/<id>.jsonl). The first
 * record is the meta; every subsequent record is a message. Title and counts are
 * derived on load so appends stay O(1).
 */
export class SessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  create(init: { cwd: string; model: string; agent: string }): SessionMeta {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: newId(),
      title: "",
      createdAt: now,
      updatedAt: now,
      cwd: init.cwd,
      model: init.model,
      agent: init.agent,
      messageCount: 0,
      schemaVersion: SESSION_SCHEMA_VERSION,
    };
    const record: SessionRecord = {
      type: "meta",
      meta: {
        id: meta.id,
        title: "",
        createdAt: now,
        cwd: init.cwd,
        model: init.model,
        agent: init.agent,
        schemaVersion: SESSION_SCHEMA_VERSION,
      },
    };
    appendFileSync(this.file(meta.id), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    return meta;
  }

  append(id: string, message: AgentMessage): void {
    const record: SessionRecord = { type: "message", message };
    appendFileSync(this.file(id), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  load(id: string): { meta: SessionMeta; messages: AgentMessage[] } | null {
    let raw: string;
    try {
      raw = readFileSync(this.file(id), "utf8");
    } catch {
      return null;
    }
    const messages: AgentMessage[] = [];
    let metaBase: SessionMetaRecord | null = null;
    let metaLineRaw: unknown = null;
    let needsPersist = false;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let record: SessionRecord;
      try {
        record = JSON.parse(line) as SessionRecord;
      } catch {
        continue;
      }
      if (record.type === "meta") {
        metaLineRaw = record.meta;
        if (sessionNeedsMigration(record.meta)) {
          metaBase = migrateSessionMeta(record.meta);
          needsPersist = true;
        } else {
          metaBase = migrateSessionMeta(record.meta);
        }
      } else if (record.type === "message") messages.push(record.message);
    }
    if (!metaBase) return null;

    if (needsPersist || !metaBase.prefixHash) {
      const systemMsg = messages.find((m) => m.role === "system");
      const toolCount = Math.max(8, Math.min(16, 8 + messages.filter((m) => m.role === "tool").length));
      const tools = Array.from({ length: toolCount }, (_, j) => ({
        type: "function" as const,
        function: { name: `tool_${j}`, description: "d", parameters: { type: "object", properties: {} } },
      }));
      const shape = computePrefixShape(systemMsg, tools, metaBase.cacheStats?.logRewriteVersion ?? 0, toolCount * 50);
      if (!metaBase.prefixHash) metaBase.prefixHash = shape.prefixHash;
      if (!metaBase.cacheStats) metaBase.cacheStats = buildCacheStats({ sessionCacheHit: 0, sessionCacheMiss: 0 }, shape);
      needsPersist = true;
    }

    if (needsPersist) {
      try {
        const upgraded = raw
          .split("\n")
          .map((line) => {
            if (!line.trim()) return line;
            try {
              const rec = JSON.parse(line) as SessionRecord;
              if (rec.type === "meta") return JSON.stringify({ type: "meta", meta: metaBase });
            } catch {
              // keep line
            }
            return line;
          })
          .join("\n");
        writeFileSync(this.file(id), upgraded.endsWith("\n") ? upgraded : `${upgraded}\n`, { encoding: "utf8", mode: 0o600 });
      } catch {
        // load still succeeds even if persist fails
      }
    }
    void metaLineRaw;

    let updatedAt = metaBase.createdAt;
    try {
      updatedAt = statSync(this.file(id)).mtime.toISOString();
    } catch {
      // keep createdAt
    }
    const firstUser = messages.find((m) => m.role === "user");
    const title = metaBase.title || (firstUser ? firstUser.content.replace(/\s+/g, " ").slice(0, 80) : "(empty session)");
    return {
      meta: { ...metaBase, title, updatedAt, messageCount: messages.length },
      messages,
    };
  }

  /** All sessions, newest first. */
  list(): SessionMeta[] {
    let entries: string[];
    try {
      entries = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      const loaded = this.load(entry.replace(/\.jsonl$/, ""));
      if (loaded) metas.push(loaded.meta);
    }
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return metas;
  }

  /** Most recent session, optionally restricted to one workspace. */
  latest(cwd?: string): SessionMeta | null {
    const all = this.list();
    if (!cwd) return all[0] ?? null;
    return all.find((m) => m.cwd === cwd) ?? all[0] ?? null;
  }
}
