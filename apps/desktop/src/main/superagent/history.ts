import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@deyin/agent-core";

/**
 * Cuts a stored conversation back to a point a model provider accepts. A run that was stopped between a model turn and its tool
 * results leaves an assistant message whose calls were never answered, and compaction can leave tool results whose request is gone;
 * both are rejected by the provider. Everything from the first such break is dropped, so the conversation resumes from its last
 * consistent state.
 */
export function repairHistory(messages: readonly AgentMessage[]): AgentMessage[] {
  const kept: AgentMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (message.role === "system") {
      index += 1;
      continue;
    }
    if (message.role === "tool") break;
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const wanted = new Set(message.toolCalls.map((call) => call.id));
      let end = index + 1;
      while (end < messages.length && messages[end]!.role === "tool") {
        wanted.delete((messages[end] as Extract<AgentMessage, { role: "tool" }>).toolCallId);
        end += 1;
      }
      if (wanted.size > 0) break;
      kept.push(...messages.slice(index, end));
      index = end;
      continue;
    }
    kept.push(message);
    index += 1;
  }
  return kept;
}

/** The most a stored conversation may take; the oldest turns go first. The loop compacts what it sends, but it keeps everything it was given. */
export const MAX_STORED_CHARS = 4_000_000;

/** `messages` without the oldest turns until it serializes within `limit`, starting at a user message so no tool result is left without its call. */
export function trimHistory(messages: readonly AgentMessage[], limit = MAX_STORED_CHARS): AgentMessage[] {
  let kept = [...messages];
  while (kept.length > 1 && JSON.stringify(kept).length > limit) {
    let next = Math.max(1, Math.ceil(kept.length / 4));
    while (next < kept.length && kept[next]!.role !== "user") next += 1;
    // A conversation with no user message after the cut keeps its last turn alone.
    kept = kept.slice(next < kept.length ? next : kept.length - 1);
  }
  return kept;
}

const SAFE = /^[A-Za-z0-9_-]{1,80}$/;

/** A file name for a session id: the id itself when it is plain, else a sanitized prefix and a hash, so distinct ids never collide. */
export function sessionFileName(sessionId: string): string {
  if (SAFE.test(sessionId)) return `${sessionId}.json`;
  const prefix = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  return `${prefix}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}.json`;
}

interface Stored {
  version: 1;
  messages: AgentMessage[];
}

/** One conversation's messages (without the system prompt), kept as an atomically written JSON file under `directory`. */
export class SessionHistory {
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; snapshot: () => AgentMessage[] }>();

  constructor(
    private readonly directory: string,
    private readonly debounceMs = 400,
  ) {}

  private file(sessionId: string): string {
    return join(this.directory, sessionFileName(sessionId));
  }

  /** The stored conversation, repaired; empty when none exists or the file is unreadable. */
  load(sessionId: string): AgentMessage[] {
    try {
      const raw = JSON.parse(readFileSync(this.file(sessionId), "utf8")) as Partial<Stored>;
      return Array.isArray(raw.messages) ? repairHistory(raw.messages) : [];
    } catch {
      return [];
    }
  }

  /** Saves a snapshot soon; later calls replace an earlier pending one, so a burst of messages costs one write. */
  schedule(sessionId: string, snapshot: () => AgentMessage[]): void {
    const existing = this.pending.get(sessionId);
    if (existing) {
      existing.snapshot = snapshot;
      return;
    }
    const entry = { snapshot, timer: setTimeout(() => this.flush(sessionId), this.debounceMs) };
    entry.timer.unref?.();
    this.pending.set(sessionId, entry);
  }

  /** Writes the pending snapshot now, if there is one. Best effort: a failed save is retried by the next one. */
  flush(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(sessionId);
    this.write(sessionId, entry.snapshot());
  }

  flushAll(): void {
    for (const sessionId of [...this.pending.keys()]) this.flush(sessionId);
  }

  /** Writes `messages` immediately, replacing any pending snapshot. */
  save(sessionId: string, messages: readonly AgentMessage[]): void {
    const entry = this.pending.get(sessionId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(sessionId);
    }
    this.write(sessionId, messages);
  }

  forget(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(sessionId);
    }
    rmSync(this.file(sessionId), { force: true });
  }

  private write(sessionId: string, messages: readonly AgentMessage[]): void {
    const target = this.file(sessionId);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      mkdirSync(this.directory, { recursive: true });
      // A run that was stopped mid-turn leaves calls without results; the file always holds a state a provider accepts.
      const body: Stored = { version: 1, messages: trimHistory(repairHistory(messages)) };
      writeFileSync(temporary, JSON.stringify(body), { mode: 0o600 });
      renameSync(temporary, target);
    } catch {
      rmSync(temporary, { force: true });
    }
  }
}
