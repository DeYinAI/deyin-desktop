import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "./types.js";

/**
 * A finished subagent run's transcript, kept so a later `task` call can resume
 * or fork it.
 *
 * Why this exists: a subagent returns one report string and its context window
 * is then thrown away. Asking the same subagent a follow-up therefore paid to
 * re-derive everything it had already worked out. Persisting the child's own
 * messages[] lets the next call continue where it stopped — the parent
 * transcript still only ever sees reports, so chat continuity is unchanged.
 */
export interface SubagentStateRecord {
  agentId: string;
  /** Subagent definition name; a resume must target the same one. */
  subagent: string;
  /** Thread/session that owns this transcript. */
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  /** Agent id this one was forked from, when it was. */
  forkedFrom?: string;
  messages: AgentMessage[];
}

/** Reject ids that could escape the state directory when used as a filename. */
function isSafeId(agentId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(agentId);
}

/**
 * File-per-agent transcript store, one JSON document under
 * `<dir>/subagent-state/<agentId>.json`.
 *
 * Writes are temp-file + rename so a crash mid-save cannot leave a torn
 * transcript that would fail to parse on the next resume. Reads never throw:
 * a missing or unreadable record simply means "cannot resume", and the caller
 * turns that into a message the model can act on.
 */
export class SubagentStateStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "subagent-state");
  }

  load(agentId: string): SubagentStateRecord | undefined {
    if (!isSafeId(agentId)) return undefined;
    try {
      const raw = readFileSync(this.pathFor(agentId), "utf8");
      const record = JSON.parse(raw) as SubagentStateRecord;
      return Array.isArray(record.messages) ? record : undefined;
    } catch {
      return undefined;
    }
  }

  save(record: SubagentStateRecord): void {
    if (!isSafeId(record.agentId)) return;
    const target = this.pathFor(record.agentId);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, target);
    } catch (err) {
      rmSync(tmp, { force: true });
      // A transcript we failed to persist only costs a future resume; never
      // fail the run the user is actually waiting on.
      console.warn(
        `[deyin] could not persist subagent transcript ${record.agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private pathFor(agentId: string): string {
    return join(this.dir, `${agentId}.json`);
  }
}

const stores = new Map<string, SubagentStateStore>();

/** One store per data directory, mirroring how the jobs manager is shared. */
export function getSubagentStateStore(dataDir: string): SubagentStateStore {
  let store = stores.get(dataDir);
  if (!store) {
    store = new SubagentStateStore(dataDir);
    stores.set(dataDir, store);
  }
  return store;
}
