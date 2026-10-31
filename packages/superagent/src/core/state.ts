/**
 * In-memory aggregate state of one Superagent deployment, serializable to JSON. Engine and drivers mutate it directly and call
 * `touch()`; the store persists whatever changed. All work in flight is derived from this state (durable assignments, receipts,
 * notices), so a restart resumes from it without a separate queue.
 */
import type { Decision, Notice, Receipt, Thread, ThreadRef, Ticket, Trigger, TriggerDisposition } from "./types.js";
import { threadKey } from "./types.js";

export const STATE_VERSION = 1;

export interface StateData {
  version: number;
  counters: Record<string, number>;
  triggers: Trigger[];
  dispositions: Record<string, TriggerDisposition>;
  threads: Thread[];
  decisions: Decision[];
  tickets: Ticket[];
  receipts: Receipt[];
  notices: Notice[];
  /** Polling cursors and other source-private bookmarks, by name. */
  cursors: Record<string, string>;
  /** Settings revision last applied, so a policy change is detected across restarts. */
  policyVersion?: string;
}

export const emptyStateData = (): StateData => ({
  version: STATE_VERSION,
  counters: {},
  triggers: [],
  dispositions: {},
  threads: [],
  decisions: [],
  tickets: [],
  receipts: [],
  notices: [],
  cursors: {},
});

/** The most messages kept besides those a live ticket or thread refers to. */
export const MAX_TRIGGERS = 5000;

const RETENTION_MS = { triggers: 30 * 86_400_000, receipts: 14 * 86_400_000, notices: 7 * 86_400_000 };

export class State {
  readonly triggers = new Map<string, Trigger>();
  readonly dispositions = new Map<string, TriggerDisposition>();
  readonly threads = new Map<string, Thread>();
  readonly decisions = new Map<string, Decision>();
  readonly tickets = new Map<string, Ticket>();
  readonly receipts = new Map<string, Receipt>();
  notices: Notice[] = [];
  cursors: Record<string, string> = {};
  policyVersion: string | undefined;
  private counters: Record<string, number> = {};
  private listeners = new Set<() => void>();
  /** Bumped on every change; lets a store tell whether anything changed since its last write. */
  revision = 0;

  static from(data: StateData | undefined): State {
    const state = new State();
    if (!data) return state;
    if (data.version !== STATE_VERSION) throw new Error(`Unsupported superagent state version ${String(data.version)}`);
    state.counters = { ...data.counters };
    for (const trigger of data.triggers) state.triggers.set(trigger.id, trigger);
    for (const [id, disposition] of Object.entries(data.dispositions)) state.dispositions.set(id, disposition);
    for (const thread of data.threads) state.threads.set(thread.key, thread);
    for (const decision of data.decisions) state.decisions.set(decision.id, decision);
    for (const ticket of data.tickets) state.tickets.set(ticket.id, ticket);
    for (const receipt of data.receipts) state.receipts.set(receipt.id, receipt);
    state.notices = [...data.notices];
    state.cursors = { ...data.cursors };
    state.policyVersion = data.policyVersion;
    return state;
  }

  toJSON(): StateData {
    return {
      version: STATE_VERSION,
      counters: this.counters,
      triggers: [...this.triggers.values()],
      dispositions: Object.fromEntries(this.dispositions),
      threads: [...this.threads.values()],
      decisions: [...this.decisions.values()],
      tickets: [...this.tickets.values()],
      receipts: [...this.receipts.values()],
      notices: this.notices,
      cursors: this.cursors,
      ...(this.policyVersion ? { policyVersion: this.policyVersion } : {}),
    };
  }

  nextId(prefix: string): string {
    const next = (this.counters[prefix] ?? 0) + 1;
    this.counters[prefix] = next;
    return `${prefix}${next}`;
  }

  /** Marks the state changed; call after any mutation. */
  touch(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  trigger(id: string): Trigger | undefined {
    return this.triggers.get(id);
  }

  disposition(id: string): TriggerDisposition | undefined {
    return this.dispositions.get(id);
  }

  /** The thread for `ref`, created when it did not exist. */
  ensureThread(ref: ThreadRef, at: string, meta: Record<string, unknown> = {}): Thread {
    const key = threadKey(ref);
    let thread = this.threads.get(key);
    if (!thread) {
      thread = { key, ref, createdAt: at, subscriptions: [], pending: [], meta: { ...meta } };
      this.threads.set(key, thread);
    } else if (Object.keys(meta).length > 0) {
      thread.meta = { ...thread.meta, ...meta };
    }
    return thread;
  }

  openTickets(): Ticket[] {
    return [...this.tickets.values()].filter((ticket) => !ticket.ended);
  }

  /** Triggers of a thread, oldest first. */
  triggersOfThread(key: string): Trigger[] {
    return [...this.triggers.values()].filter((trigger) => trigger.threads.some((ref) => threadKey(ref) === key));
  }

  /** Drops old history nothing live refers to. Returns how many records were removed. */
  prune(now: Date): number {
    const cutoff = (ms: number) => new Date(now.getTime() - ms).toISOString();
    let removed = 0;
    const keep = new Set<string>();
    for (const ticket of this.tickets.values()) {
      if (ticket.ended && ticket.ended.at < cutoff(RETENTION_MS.triggers)) continue;
      keep.add(ticket.origin.triggerId);
      for (const id of ticket.origin.triggerIds) keep.add(id);
      for (const input of ticket.inputs) if ("triggerId" in input) keep.add(input.triggerId);
      if (ticket.attention?.triggerId) keep.add(ticket.attention.triggerId);
    }
    for (const thread of this.threads.values()) {
      for (const id of thread.pending) keep.add(id);
      for (const id of thread.evaluating?.triggerIds ?? []) keep.add(id);
    }
    for (const receipt of this.receipts.values()) if (receipt.status === "pending" && receipt.triggerId) keep.add(receipt.triggerId);
    const triggerCutoff = cutoff(RETENTION_MS.triggers);
    for (const trigger of [...this.triggers.values()]) {
      if (trigger.at >= triggerCutoff || keep.has(trigger.id)) continue;
      this.triggers.delete(trigger.id);
      this.dispositions.delete(trigger.id);
      removed++;
    }
    // However busy the repository, the history has a size: the oldest messages nothing live refers to go first.
    if (this.triggers.size > MAX_TRIGGERS) {
      const droppable = [...this.triggers.values()].filter((trigger) => !keep.has(trigger.id)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      for (const trigger of droppable.slice(0, this.triggers.size - MAX_TRIGGERS)) {
        this.triggers.delete(trigger.id);
        this.dispositions.delete(trigger.id);
        removed++;
      }
    }
    const receiptCutoff = cutoff(RETENTION_MS.receipts);
    for (const receipt of [...this.receipts.values()]) {
      if (receipt.status !== "pending" && receipt.createdAt < receiptCutoff) {
        this.receipts.delete(receipt.id);
        removed++;
      }
    }
    const noticeCutoff = cutoff(RETENTION_MS.notices);
    const before = this.notices.length;
    this.notices = this.notices.filter((notice) => !notice.delivered || notice.at >= noticeCutoff);
    removed += before - this.notices.length;
    if (removed > 0) this.touch();
    return removed;
  }
}
