/** Pure helpers for the sidebar's per-session activity mark (spinner / unread dot). */

/** What a session row's leading slot shows. */
export type ThreadActivity = "running" | "unread" | "idle";

export interface ThreadActivityInput {
  /** An agent run, chat stream or media generation is in flight for the thread. */
  running: boolean;
  /** Approvals, questions or auth requests the thread is blocked on. */
  pending: number;
  /** The thread produced something while it was not the open one. */
  unread: boolean;
}

/**
 * A run blocked on the user is not making progress, so it gets no spinner: the
 * amber pending badge is the signal and the unread dot (set when the request
 * arrived while away) stays. Running outranks unread, so the mark flips from
 * spinner to dot the moment the work finishes.
 */
export function threadActivity(input: ThreadActivityInput): ThreadActivity {
  if (input.running && input.pending === 0) return "running";
  if (input.unread) return "unread";
  return "idle";
}

/**
 * Every thread with work in flight: agent runs from the run store plus plain
 * chat and media generations, which are tracked as per-thread stream text.
 */
export function mergeRunningThreadIds(
  agentRunning: readonly string[],
  plainStreamByThread: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  return new Set([...agentRunning, ...Object.keys(plainStreamByThread)]);
}
