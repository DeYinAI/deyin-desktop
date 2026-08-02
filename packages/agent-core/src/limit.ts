/**
 * Bounded concurrency gate (semaphore). `run(fn)` executes `fn` immediately
 * when a slot is free, otherwise queues it FIFO until a slot opens. The limit
 * is re-read at each acquisition, so lowering it mid-run takes effect on the
 * next queued task.
 */
export class Semaphore {
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly limit: () => number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const max = Math.max(1, Math.floor(this.limit()));
    if (this.running >= max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}
