import type { ThreadEvent } from "../threads.js";

/** A conversation turn: user message → process material → assistant answer. */
export interface ConversationTurn {
  index: number;
  user: Extract<ThreadEvent, { kind: "user" }> | null;
  process: ThreadEvent[];
  assistant: Extract<ThreadEvent, { kind: "assistant" }> | null;
  /** First event index in the flat timeline. */
  startEventIndex: number;
}

export interface TurnZone {
  zone: "hot" | "warm" | "cold";
  turns: ConversationTurn[];
}

export const HOT_TURN_LIMIT = 30;
export const WARM_TURN_LIMIT = 100;
export const COLD_PAGE_SIZE = 50;

/** Group flat events into user → process → assistant turns. */
export function groupIntoTurns(events: ThreadEvent[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | null = null;
  let eventIndex = 0;

  const pushTurn = () => {
    if (current) turns.push(current);
    current = null;
  };

  for (const event of events) {
    if (event.kind === "user") {
      pushTurn();
      current = {
        index: turns.length,
        user: event,
        process: [],
        assistant: null,
        startEventIndex: eventIndex,
      };
    } else if (event.kind === "assistant") {
      if (!current) {
        current = {
          index: turns.length,
          user: null,
          process: [],
          assistant: event,
          startEventIndex: eventIndex,
        };
      } else {
        current.assistant = event;
      }
      pushTurn();
    } else if (current) {
      current.process.push(event);
    } else {
      // Orphan process events before first user — attach to synthetic turn
      current = {
        index: turns.length,
        user: null,
        process: [event],
        assistant: null,
        startEventIndex: eventIndex,
      };
    }
    eventIndex += 1;
  }
  pushTurn();
  return turns;
}

/** Split turns into hot / warm / cold zones for pagination. */
export function partitionTurnZones(turns: ConversationTurn[], coldLoaded: number): TurnZone[] {
  const total = turns.length;
  if (total === 0) return [];

  const zones: TurnZone[] = [];
  const coldEnd = Math.max(0, total - WARM_TURN_LIMIT);
  const coldVisible = Math.min(coldEnd, coldLoaded);
  const warmStart = coldEnd;
  const warmEnd = Math.max(warmStart, total - HOT_TURN_LIMIT);
  const hotStart = warmEnd;

  if (coldEnd > 0) {
    if (coldVisible > 0) {
      zones.push({ zone: "cold", turns: turns.slice(0, coldVisible) });
    }
    if (coldVisible < coldEnd) {
      zones.push({ zone: "cold", turns: [] }); // placeholder for load-more
    }
  }
  if (warmEnd > warmStart) {
    zones.push({ zone: "warm", turns: turns.slice(warmStart, warmEnd) });
  }
  if (total > hotStart) {
    zones.push({ zone: "hot", turns: turns.slice(hotStart) });
  }
  return zones;
}

/** Summarize process material for warm-zone collapsed cards. */
export function summarizeProcess(process: ThreadEvent[]): string {
  const tools = process.filter((e) => e.kind === "tool").length;
  const files = process.filter((e) => e.kind === "file").length;
  const thoughts = process.filter((e) => e.kind === "thought" || e.kind === "reasoning").length;
  const parts: string[] = [];
  if (tools > 0) parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (thoughts > 0) parts.push(`${thoughts} step${thoughts === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : `${process.length} events`;
}

/** Search turns by user/assistant text content. */
export function searchTurns(turns: ConversationTurn[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: number[] = [];
  for (const turn of turns) {
    const blob = [
      turn.user?.text ?? "",
      turn.assistant?.text ?? "",
      ...turn.process.map((e) => ("text" in e ? String(e.text) : "label" in e ? String(e.label) : "")),
    ]
      .join("\n")
      .toLowerCase();
    if (blob.includes(q)) hits.push(turn.index);
  }
  return hits;
}

export function turnPreview(turn: ConversationTurn, maxLen = 80): string {
  const text = turn.user?.text ?? turn.assistant?.text ?? summarizeProcess(turn.process);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}
