import type { AutomationRun } from "@deyin/host-core";

/** What a message's run came to, in the words the hub needs. */
export interface RunEnd {
  status: AutomationRun["status"];
  reason?: string;
  /** What the Bot said back: its report. */
  reply: string;
}

function over(run: Pick<AutomationRun, "status">): boolean {
  return run.status !== "queued" && run.status !== "running";
}

function endOf(run: AutomationRun): RunEnd {
  return { status: run.status, ...(run.reason ? { reason: run.reason } : {}), reply: run.finalText?.trim() ?? "" };
}

/**
 * Lets the hub wait for a run to be over. The runner announces each run that ends; this hands that to whoever asked,
 * and answers at once for a run that was over before it was asked about.
 */
export class RunWatch {
  private readonly waiting = new Map<string, Array<(end: RunEnd) => void>>();

  /**
   * `maxWaitMs` is a ceiling, not an expectation: every way a run can end is announced, but a wait that outlives all of
   * them would otherwise hold a reply, and what it remembers, until the app closes.
   */
  constructor(
    private readonly lookup: (runId: string) => AutomationRun | undefined,
    private readonly maxWaitMs: number = 2 * 60 * 60_000,
  ) {}

  /** Call for every run the runner finishes. */
  finished(run: AutomationRun): void {
    if (!over(run)) return;
    const listeners = this.waiting.get(run.id);
    if (!listeners) return;
    this.waiting.delete(run.id);
    const end = endOf(run);
    for (const listener of listeners) listener(end);
  }

  settled(runId: string): Promise<RunEnd> {
    const now = this.lookup(runId);
    // A run that cannot be found is over: nothing will ever announce it.
    if (!now) return Promise.resolve({ status: "aborted", reason: "run not found", reply: "" });
    if (over(now)) return Promise.resolve(endOf(now));
    return new Promise((resolve) => {
      const listeners = this.waiting.get(runId) ?? [];
      const give = (end: RunEnd): void => {
        clearTimeout(timer);
        resolve(end);
      };
      const timer = setTimeout(() => {
        const rest = (this.waiting.get(runId) ?? []).filter((listener) => listener !== give);
        if (rest.length > 0) this.waiting.set(runId, rest);
        else this.waiting.delete(runId);
        resolve({ status: "aborted", reason: "gave up waiting", reply: "" });
      }, this.maxWaitMs);
      timer.unref();
      listeners.push(give);
      this.waiting.set(runId, listeners);
    });
  }

  /** How many runs are being waited for. */
  pending(): number {
    return this.waiting.size;
  }
}
