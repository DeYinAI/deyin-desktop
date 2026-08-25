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
