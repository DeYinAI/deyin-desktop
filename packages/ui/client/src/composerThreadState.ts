/** Pure helpers for per-thread composer isolation (multi-chat concurrency). */

export function shouldQueueFollowUp(opts: {
  threadId: string;
  isThreadRunning: boolean;
  streamText: string | null;
  busyThreadId: string | null;
}): boolean {
  return (
    opts.isThreadRunning ||
    (opts.streamText !== null && opts.busyThreadId === opts.threadId)
  );
}

export function resolveChatStreamText(opts: {
  activeThreadId: string | null;
  agentStreamText: string | null;
  streamText: string | null;
  busyThreadId: string | null;
}): string | null {
  if (opts.agentStreamText !== null) return opts.agentStreamText;
  if (
    opts.activeThreadId !== null &&
    opts.streamText !== null &&
    opts.busyThreadId === opts.activeThreadId
  ) {
    return opts.streamText;
  }
  return null;
}

export function pickRunningThreadToStop(opts: {
  activeThreadId: string | null;
  runningThreadId: string | null;
  isActiveThreadRunning: boolean;
  isActiveComposerBusy: boolean;
}): string | null {
  if ((opts.isActiveThreadRunning || opts.isActiveComposerBusy) && opts.activeThreadId) {
    return opts.activeThreadId;
  }
  return opts.runningThreadId;
}

/** Per-thread pending user interactions (permission, question, MCP auth). */
export interface PendingInteractionsState {
  approvalsByThread: Record<string, readonly unknown[]>;
  questionByThread: Record<string, readonly unknown[] | unknown | null | undefined>;
  mcpAuthByThread: Record<string, readonly unknown[]>;
}

/** Count pending interactions blocking a single thread. */
export function countPendingInteractionsForThread(
  threadId: string,
  pending: PendingInteractionsState,
): number {
  const approvals = pending.approvalsByThread[threadId]?.length ?? 0;
  const questions = pending.questionByThread[threadId];
  const questionCount = Array.isArray(questions) ? questions.length : questions ? 1 : 0;
  const mcpAuth = pending.mcpAuthByThread[threadId]?.length ?? 0;
  return approvals + questionCount + mcpAuth;
}

/** Pending interaction counts keyed by thread id (sidebar badge helper). */
export function countPendingInteractionsByThread(
  threadIds: readonly string[],
  pending: PendingInteractionsState,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const threadId of threadIds) {
    counts[threadId] = countPendingInteractionsForThread(threadId, pending);
  }
  return counts;
}

/** Pending approvals, MCP auth prompts, and question dialogs awaiting user input. */
export function countPendingInteractions(opts: {
  approvals?: number;
  mcpAuth?: number;
  questions?: number;
}): number {
  return (opts.approvals ?? 0) + (opts.mcpAuth ?? 0) + (opts.questions ?? 0);
}

/** Show Stop when any agent run is active or the focused thread is streaming. */
export function shouldShowGlobalStop(opts: {
  runningThreadId: string | null;
  isActiveThreadStreaming: boolean;
}): boolean {
  return opts.runningThreadId !== null || opts.isActiveThreadStreaming;
}
