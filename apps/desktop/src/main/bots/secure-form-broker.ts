import { randomUUID } from "node:crypto";
import { cleanSecureFormAnswer, type SecureFormRequest } from "@deyin/host-core/shared";

interface Pending {
  threadId: string;
  form: SecureFormRequest;
  resolve: (values: Record<string, string> | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Secure Forms waiting for a person. A form is shown on its thread; the answer comes back by request id and is
 * checked against what was asked (no extra fields, nothing too long) before it reaches the page. What was typed
 * is only ever held here long enough to be handed on: it is not logged, not sent as an event, and a form that
 * is cancelled, times out or loses its run answers `null`.
 */
export class SecureFormBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs: number) {}

  /** Show `form` with `show` and wait for the answer: the values typed, or `null` when it was cancelled, closed or timed out. */
  ask(threadId: string, form: SecureFormRequest, show: (requestId: string, form: SecureFormRequest) => void): Promise<Record<string, string> | null> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, this.timeoutMs);
      this.pending.set(requestId, { threadId, form, resolve, timer });
      try {
        show(requestId, form);
      } catch {
        // A form that cannot be shown is a form nobody can answer.
        this.settle(requestId, null);
      }
    });
  }

  /** The person's answer, from the renderer: untrusted, so it is cleaned against the form first. A second answer is ignored. */
  answer(requestId: unknown, values: unknown): void {
    if (typeof requestId !== "string") return;
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.settle(requestId, cleanSecureFormAnswer(entry.form, values));
  }

  /** A run ended or was stopped: its open forms are cancelled. */
  cancelThread(threadId: string): void {
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.threadId === threadId) this.settle(requestId, null);
    }
  }

  /** How many forms are open. */
  size(): number {
    return this.pending.size;
  }

  private settle(requestId: string, values: Record<string, string> | null): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(values);
  }
}
