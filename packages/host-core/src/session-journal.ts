/**
 * Append-only session event journal — the seed of the event-sourced session
 * spine (dsh's "model-visible means logged"). Every UI event a host forwards
 * is journaled as one JSONL line per session; replay reconstructs the
 * transcript without the original in-memory state. The web session host
 * journals into the sandbox so a refresh/reconnect can rebuild a thread.
 */
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentUiEvent } from "./types.js";

export interface SessionJournalEntry {
  /** Monotonic per-session sequence, 1-based. */
  seq: number;
  /** Wall-clock epoch ms at append time. */
  ts: number;
  event: AgentUiEvent;
}

/** Fold journal events back into an ordered chat transcript. */
export interface JournalTranscriptItem {
  role: "assistant" | "system";
  content: string;
}

export class SessionEventJournal {
  private readonly seqs = new Map<string, number>();

  constructor(private readonly journalDir: string) {}

  /** Append one event; journal failures must never break the run (logged by caller). */
  async append(sessionId: string, event: AgentUiEvent): Promise<SessionJournalEntry> {
    const seq = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, seq);
    const entry: SessionJournalEntry = { seq, ts: Date.now(), event };
    await mkdir(this.journalDir, { recursive: true });
    await appendFile(this.fileFor(sessionId), `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  /** Replay every entry for a session, in append order. */
  async read(sessionId: string): Promise<SessionJournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(sessionId), "utf8");
    } catch {
      return []; // no journal yet = empty history, not an error
    }
    const entries: SessionJournalEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as SessionJournalEntry);
      } catch {
        // Torn tail line from a crash mid-append: stop at the last full entry.
        break;
      }
    }
    this.seqs.set(sessionId, entries.at(-1)?.seq ?? 0);
    return entries;
  }

  /** Which sessions have journals on disk. */
  async sessions(): Promise<string[]> {
    try {
      const files = await readdir(this.journalDir);
      return files.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
    } catch {
      return [];
    }
  }

  /**
   * Fold entries into an ordered transcript: consecutive text-deltas merge
   * into one assistant item; system-ish rows (compaction, stop-reason) become
   * system items. Tool chatter is intentionally dropped — it derivable from
   * the raw journal.
   */
  static transcript(entries: readonly SessionJournalEntry[]): JournalTranscriptItem[] {
    const items: JournalTranscriptItem[] = [];
    let pending: string | null = null;
    for (const { event } of entries) {
      if (event.type === "text-delta") {
        pending = (pending ?? "") + event.delta;
      } else if (event.type === "done") {
        if (pending !== null) {
          items.push({ role: "assistant", content: pending });
          pending = null;
        }
        if (event.reason && event.reason !== "completed") {
          items.push({ role: "system", content: `run ${event.reason}` });
        }
      } else if (event.type === "compaction" && (event.kind === "prune" || event.kind === "fold")) {
        // A pressure notice changed nothing, so it is not part of the transcript.
        items.push({ role: "system", content: event.kind === "fold" ? "context folded" : "context pruned" });
      }
    }
    if (pending !== null) items.push({ role: "assistant", content: pending });
    return items;
  }

  private fileFor(sessionId: string): string {
    // Session ids are host-generated (uuid/thread ids); flatten anything path-like.
    const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(this.journalDir, `${safe}.jsonl`);
  }
}
