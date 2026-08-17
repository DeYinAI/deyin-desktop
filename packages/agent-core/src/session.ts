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

/**
 * Lifecycle facts journaled into the session log. The log is the spine:
 * every model-visible message AND every structural fact is an append-only
 * record; sessions, transcripts, forks, and replays are derived from it.
 */
export type SessionLifecycleEvent =
  | { kind: "session-created"; cwd: string; model: string; agent: string }
  | { kind: "forked"; from: string; atSeq: number }
  | { kind: "title-set"; title: string }
  | { kind: "compaction"; droppedMessages: number };

/** One replayable log event: seq counts non-meta records from 1. */
export type SessionLogEvent =
  | { seq: number; type: "message"; message: AgentMessage }
  | { seq: number; type: "lifecycle"; ts: string; event: SessionLifecycleEvent };

type SessionRecord =
  | { type: "meta"; meta: SessionMetaRecord }
  | { type: "message"; message: AgentMessage }
  | { type: "lifecycle"; ts: string; event: SessionLifecycleEvent };

function newId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Append one record as its own line. The leading newline is a self-healing
 * boundary: if a previous write was torn mid-record (crash), this record
 * still starts on a fresh line instead of being glued to the fragment and
 * lost to both replay and load. Blank lines are skipped by all parsers.
 */
function appendLine(file: string, line: string): void {
  appendFileSync(file, `\n${line}\n`, { encoding: "utf8", mode: 0o600 });
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
    this.appendEvent(meta.id, { kind: "session-created", cwd: init.cwd, model: init.model, agent: init.agent });
    return meta;
  }

  append(id: string, message: AgentMessage): void {
    const record: SessionRecord = { type: "message", message };
    appendLine(this.file(id), JSON.stringify(record));
  }

  /** Journal a structural fact; append-only, like every other record. */
  appendEvent(id: string, event: SessionLifecycleEvent): void {
    const record: SessionRecord = { type: "lifecycle", ts: new Date().toISOString(), event };
    appendLine(this.file(id), JSON.stringify(record));
  }

  /**
   * Replay the log: every non-meta record in append order with its seq.
   * Malformed lines (a crash mid-append) are skipped — same tolerance as
   * load() — so records appended after a torn line still replay. Messages
   * and lifecycle facts are both first-class.
   */
  events(id: string): SessionLogEvent[] {
    let raw: string;
    try {
      raw = readFileSync(this.file(id), "utf8");
    } catch {
      return [];
    }
    const out: SessionLogEvent[] = [];
    let seq = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let record: SessionRecord;
      try {
        record = JSON.parse(line) as SessionRecord;
      } catch {
        continue; // torn line from a crash mid-append
      }
      if (record.type === "meta") continue;
      seq += 1;
      if (record.type === "message") out.push({ seq, type: "message", message: record.message });
      else if (record.type === "lifecycle") out.push({ seq, type: "lifecycle", ts: record.ts, event: record.event });
    }
    return out;
  }

  /**
   * Fork a session: a new log whose records are a verbatim copy of the
   * source's up to `atSeq` (full copy when omitted), opened by a fresh meta
   * line and a `forked` lifecycle event. The fork replays to exactly the
   * source transcript prefix; the source log is never touched.
   */
  fork(id: string, opts?: { atSeq?: number }): SessionMeta | null {
    const source = this.load(id);
    if (!source) return null;
    const atSeq = opts?.atSeq;
    const copied: string[] = [];
    for (const event of this.events(id)) {
      if (atSeq !== undefined && event.seq > atSeq) break;
      if (event.type === "message") copied.push(JSON.stringify({ type: "message", message: event.message }));
      else copied.push(JSON.stringify({ type: "lifecycle", ts: event.ts, event: event.event }));
    }
    const now = new Date().toISOString();
    const newSessionId = newId();
    const metaRecord: SessionMetaRecord = {
      id: newSessionId,
      title: "",
      createdAt: now,
      cwd: source.meta.cwd,
      model: source.meta.model,
      agent: source.meta.agent,
      schemaVersion: SESSION_SCHEMA_VERSION,
      forkedFrom: id,
    };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lines = [
      JSON.stringify({ type: "meta", meta: metaRecord }),
      ...copied,
      // atSeq records how far the fork copied (-1 = the whole log).
      JSON.stringify({
        type: "lifecycle",
        ts: now,
        event: { kind: "forked", from: id, atSeq: atSeq ?? -1 } satisfies SessionLifecycleEvent,
      }),
    ];
    writeFileSync(this.file(newSessionId), `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    return this.load(newSessionId)?.meta ?? null;
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
