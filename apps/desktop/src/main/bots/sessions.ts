import type { SessionStore } from "@deyin/agent-core";

/** The part of the agent host that knows which UI thread is running which stored session. */
export type LiveThreadSessions = ReadonlyMap<string, { sessionId: string }>;

/**
 * Delete every conversation a deleted Bot had.
 *
 * Live runs are stopped and their in-memory sessions dropped before the logs are removed, so a thread that
 * is still open cannot keep appending to a transcript that no longer exists. Returns how many stored
 * conversations were removed. Conversations that belong to other Bots, or to none, are never touched.
 */
export function removeBotSessions(
  store: Pick<SessionStore, "listForBot" | "remove">,
  live: LiveThreadSessions,
  resetThread: (threadId: string) => void,
  botId: string,
): number {
  const doomed = store.listForBot(botId);
  const doomedIds = new Set(doomed.map((meta) => meta.id));
  for (const [threadId, session] of [...live]) {
    if (doomedIds.has(session.sessionId)) resetThread(threadId);
  }
  let removed = 0;
  for (const meta of doomed) if (store.remove(meta.id)) removed += 1;
  return removed;
}
