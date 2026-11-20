import type { AgentUiEvent, AutomationRunSummary } from "./types.js";

/**
 * The stored history of one automation run.
 *
 * A run streams hundreds of one-token `text-delta` events. Keeping "the last N
 * events" meant a long run's tool calls were evicted by the very text that
 * followed them, so a run that posted to X looked like a run that did nothing.
 * Here deltas coalesce into chunks, the log is bounded by priority rather than
 * age alone, and the counters that matter (tool calls, errors) live outside the
 * log where eviction cannot reach them.
 */

/** A text chunk grows to this size before a new one starts. */
export const TEXT_CHUNK_CHARS = 4_000;
/** All text and reasoning together; the oldest chunks go first. */
export const MAX_TEXT_CHARS = 16_000;
/** Total events kept per run. */
export const MAX_RUN_EVENTS = 500;
/** Eviction trims to here so it runs once per batch, not once per event. */
export const LOW_WATER_EVENTS = 450;
/** A stored tool result. Live viewers got the full text; history only needs the gist. */
export const TOOL_RESULT_STORE_CHARS = 600;
/** Errors are what a person (or the healer) reads later, so they keep more. */
export const TOOL_ERROR_STORE_CHARS = 1_500;
const ERROR_SUMMARY_CHARS = 240;

const TRUNCATED = "… (truncated)";

type EventType = AgentUiEvent["type"];

const DELTAS: ReadonlySet<EventType> = new Set<EventType>(["text-delta", "reasoning-delta"]);
/** Streaming scraps that are dropped on arrival: the matching tool-end carries the result. */
const NOT_STORED: ReadonlySet<EventType> = new Set<EventType>(["tool-delta", "context-snapshot", "optimization"]);
/** Dropped first when the log is full; nothing a person reads to learn what happened. */
const NOISE: ReadonlySet<EventType> = new Set<EventType>(["usage", "todos"]);
/** Never dropped: how the run ended. */
const PINNED: ReadonlySet<EventType> = new Set<EventType>(["error", "done"]);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}${TRUNCATED}` : text;
}

/** The event as it is stored: results shortened, nothing else changed. */
function forStorage(event: AgentUiEvent): AgentUiEvent {
  if (event.type !== "tool-end") return event;
  const max = event.ok ? TOOL_RESULT_STORE_CHARS : TOOL_ERROR_STORE_CHARS;
  return event.result.length > max ? { ...event, result: clip(event.result, max) } : event;
}

export function emptySummary(): AutomationRunSummary {
  return { steps: 0, toolCalls: {}, toolErrors: 0 };
}

/** Fold one event into the run's counters. Counters are never evicted. */
export function updateSummary(summary: AutomationRunSummary, event: AgentUiEvent): void {
  if (event.type === "tool-start") {
    summary.steps += 1;
    summary.toolCalls[event.name] = (summary.toolCalls[event.name] ?? 0) + 1;
    summary.lastTool = event.name;
  } else if (event.type === "tool-end" && !event.ok) {
    summary.toolErrors += 1;
    summary.lastError = clip(`${event.name}: ${event.result}`, ERROR_SUMMARY_CHARS);
  } else if (event.type === "error") {
    summary.lastError = clip(event.message, ERROR_SUMMARY_CHARS);
  }
}

function textLength(event: AgentUiEvent): number {
  return event.type === "text-delta" || event.type === "reasoning-delta" ? event.delta.length : 0;
}

/** Bounded event history for one run. `events` is replaced on eviction, so read it after each push. */
export class RunEventLog {
  events: AgentUiEvent[];
  private textChars: number;

  constructor(existing: AgentUiEvent[] = []) {
    this.events = existing;
    this.textChars = existing.reduce((sum, e) => sum + textLength(e), 0);
  }

  push(raw: AgentUiEvent): void {
    if (NOT_STORED.has(raw.type)) return;
    const event = forStorage(raw);

    const last = this.events.at(-1);
    if (DELTAS.has(event.type) && last && last.type === event.type) {
      const joined = (last as { delta: string }).delta;
      if (joined.length < TEXT_CHUNK_CHARS) {
        (last as { delta: string }).delta = joined + (event as { delta: string }).delta;
        this.textChars += textLength(event);
        this.enforce();
        return;
      }
    }

    // Copy deltas: the stored chunk is mutated when the next delta merges into it, and the
    // caller's object may be the very one a live viewer is still holding.
    this.events.push(DELTAS.has(event.type) ? { ...event } : event);
    this.textChars += textLength(event);
    this.enforce();
  }

  private enforce(): void {
    if (this.textChars > MAX_TEXT_CHARS) this.dropText();
    if (this.events.length > MAX_RUN_EVENTS) this.dropToLowWater();
  }

  /** Oldest text and reasoning first, until the text budget holds again. */
  private dropText(): void {
    const kept: AgentUiEvent[] = [];
    let excess = this.textChars - MAX_TEXT_CHARS;
    for (const event of this.events) {
      if (excess > 0 && DELTAS.has(event.type)) {
        const size = textLength(event);
        excess -= size;
        this.textChars -= size;
        continue;
      }
      kept.push(event);
    }
    this.events = kept;
  }

  /** Make room by priority: noise, then text, then the oldest tool activity. Pinned events stay. */
  private dropToLowWater(): void {
    let remove = this.events.length - LOW_WATER_EVENTS;
    const doomed = new Set<number>();
    const take = (match: (e: AgentUiEvent) => boolean): void => {
      for (let i = 0; i < this.events.length && remove > 0; i++) {
        const event = this.events[i]!;
        if (doomed.has(i) || PINNED.has(event.type) || !match(event)) continue;
        doomed.add(i);
        remove -= 1;
      }
    };
    take((e) => NOISE.has(e.type));
    take((e) => DELTAS.has(e.type));
    take(() => true);

    this.events = this.events.filter((event, i) => {
      if (!doomed.has(i)) return true;
      this.textChars -= textLength(event);
      return false;
    });
  }
}
