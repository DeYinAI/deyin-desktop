import { BotError, parseTeachPageEvent, type TeachEvent } from "@deyin/host-core";
import { TEACH_DRAIN_SCRIPT, TEACH_PAGE_SCRIPT } from "./teach-page-script.js";

/** One browser tab as capture needs it. The Electron tab implements it; a test supplies its own. */
export interface TeachTarget {
  readonly id: number;
  url(): string;
  title(): string;
  /** Run a script in the page's own isolated world (not the page's, so the page cannot see it) and return what it gives back. */
  run(script: string): Promise<unknown>;
  /** Be told after the page loads or goes somewhere else. Returns how to stop being told. */
  onNavigate(listener: () => void): () => void;
}

export interface TeachCaptureDeps {
  /** The tab the person is in now, or null when no browser tab is open. */
  active(): TeachTarget | null;
  /** Called with each event, in the order they happened. */
  onEvent(event: TeachEvent): void;
  /** How often what the page saw is collected. */
  pollMs?: number;
}

export interface CaptureHandle {
  /** Begin watching. Refuses (with words) when there is no page to watch. */
  start(): void;
  /** Stop watching, after taking what the page saw last. */
  stop(): Promise<void>;
}

/**
 * Watches the person's browser tab while they teach a Bot. The page script keeps what the person does; this collects
 * it a few times a second and says when they open a page. The person may move to another tab: capture goes with
 * them, and a page that loads again is given the script again. Only the top page is watched, not frames inside it.
 */
export class TeachCapture implements CaptureHandle {
  private bound: { target: TeachTarget; off: () => void } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: TeachCaptureDeps) {}

  start(): void {
    const first = this.deps.active();
    if (!first) throw new BotError("conflict", "Open the Browser tab and go to the page where the task starts, then begin.");
    this.stopped = false;
    this.bind(first);
    this.timer = setInterval(() => this.tick(), this.deps.pollMs ?? 400);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
    // What the person did in the last moment before they stopped is still in the page.
    const target = this.bound?.target;
    if (target) await this.collect(target);
    this.unbind();
  }

  private bind(target: TeachTarget): void {
    this.unbind();
    this.bound = { target, off: target.onNavigate(() => void this.arrived(target)) };
    void this.arrived(target);
  }

  private unbind(): void {
    this.bound?.off();
    this.bound = null;
  }

  /** A page is there now: say so, and give it the script. */
  private async arrived(target: TeachTarget): Promise<void> {
    if (this.stopped || this.bound?.target !== target) return;
    this.deps.onEvent({ kind: "open", url: target.url(), title: target.title() });
    try {
      await target.run(TEACH_PAGE_SCRIPT);
    } catch {
      // A page that cannot be watched (it is closing, or an error page) is simply not recorded.
    }
  }

  private tick(): void {
    // One collection at a time: a slow page must not pile up work behind it.
    this.running = this.running.then(() => this.poll()).catch(() => undefined);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    const active = this.deps.active();
    if (active && active.id !== this.bound?.target.id) this.bind(active);
    const target = this.bound?.target;
    if (target) await this.collect(target);
  }

  private async collect(target: TeachTarget): Promise<void> {
    let raw: unknown;
    try {
      raw = await target.run(TEACH_DRAIN_SCRIPT);
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      const event = parseTeachPageEvent(item);
      if (event) this.deps.onEvent(event);
    }
  }
}
