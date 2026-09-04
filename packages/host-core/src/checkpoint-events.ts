import type { ThreadEvent } from "./types.js";
import type { FileCheckpointRecord } from "./checkpoints.js";

/** Infer write/edit/delete from before/after snapshots. */
export function inferCheckpointOperation(before: string, after: string): FileCheckpointRecord["operation"] {
  if (before === "" && after !== "") return "write";
  if (before !== "" && after === "") return "delete";
  return "edit";
}

/** Checkpoint ids on timeline events at or after `eventIndex` (for edit-and-resend revert). */
export function checkpointIdsFromEventsAfterIndex(events: ThreadEvent[], eventIndex: number): string[] {
  const ids = new Set<string>();
  for (let i = eventIndex; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "file" && e.checkpointId) ids.add(e.checkpointId);
    if (e.kind === "thought" && e.checkpointId) ids.add(e.checkpointId);
  }
  return [...ids];
}

/** All checkpoint ids referenced in a thread timeline (for prune after truncate). */
export function collectCheckpointIdsInThread(events: ThreadEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.kind === "file" && e.checkpointId) ids.add(e.checkpointId);
    if (e.kind === "thought" && e.checkpointId) ids.add(e.checkpointId);
  }
  return ids;
}

/** True when a stopped-run thought can offer revert (has checkpoint with file entries). */
export function isRevertableStopThought(event: Extract<ThreadEvent, { kind: "thought" }>): boolean {
  return event.revertable === true || Boolean(event.checkpointId);
}
