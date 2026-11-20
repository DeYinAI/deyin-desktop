import type { ComputerUseState } from "@deyin/contract";

/** The user stopped computer use (Stop button, Stop chord, or the run was cancelled). */
export class ComputerUseStoppedError extends Error {
  constructor(message = "Computer use was stopped by the user.") {
    super(message);
    this.name = "ComputerUseStoppedError";
  }
}

/** What an action is about, for the overlay and for permission prompts. */
export interface ActionLabel {
  /** Process being driven (for example `notepad`). */
  app?: string;
  /** Short human label, for example `click s3e12`. */
  action: string;
}

/** A pause that nobody resumes (the run ended while paused) must not leave the overlay up forever. */
const PAUSE_EXPIRES_MS = 2 * 60_000;

type StateListener = (state: ComputerUseState) => void;

interface PauseWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  detach: () => void;
}

/**
 * Tracks what computer use is doing right now: which actions are in flight, whether the host is using the real
 * mouse and keyboard, and whether the user took over. It also owns cancellation: one Stop aborts every action.
 *
 * Electron-free so it can be tested directly; the desktop service forwards `onState` to the overlay windows.
 */
export class ComputerUseSession {
  private inFlight = 0;
  private controller: AbortController | null = null;
  private paused = false;
  private pauseTimer: NodeJS.Timeout | null = null;
  private rawInput = false;
  private point: { x: number; y: number } | undefined;
  private label: ActionLabel | undefined;
  private readonly waiters = new Set<PauseWaiter>();
  private readonly listeners = new Set<StateListener>();
  private lastSent = "";

  state(): ComputerUseState {
    const phase = this.paused ? "paused" : this.inFlight === 0 ? "idle" : this.rawInput ? "input" : "background";
    const state: ComputerUseState = { phase };
    if (phase !== "idle" || this.paused) {
      if (this.label?.app) state.app = this.label.app;
      if (this.label?.action) state.action = this.label.action;
      if (this.point) state.point = this.point;
    }
    return state;
  }

  onState(cb: StateListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** True while any action is running or waiting to run. */
  get active(): boolean {
    return this.inFlight > 0 || this.paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Run one action. If the user has taken over, waits until they resume (or stop). `outer` is the agent run's own
   * cancellation, which stops the action the same way Stop does.
   */
  async run<T>(label: ActionLabel, fn: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
    if (outer?.aborted) throw new ComputerUseStoppedError();
    if (this.inFlight === 0) {
      this.controller = new AbortController();
      this.rawInput = false;
      this.point = undefined;
    }
    const controller = this.controller as AbortController;
    const signal = outer ? AbortSignal.any([controller.signal, outer]) : controller.signal;
    this.inFlight += 1;
    this.label = label;
    this.emit();
    try {
      await this.waitWhilePaused(signal);
      if (signal.aborted) throw new ComputerUseStoppedError();
      return await fn(signal);
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        this.controller = null;
        this.rawInput = false;
        this.point = undefined;
        this.label = undefined;
      }
      this.emit();
    }
  }

  /** The host started or finished using the real mouse and keyboard. `point` is where it is about to act. */
  setRawInput(active: boolean, point?: { x: number; y: number }): void {
    if (this.inFlight === 0) return;
    this.rawInput = active;
    this.point = active ? point : undefined;
    this.emit();
  }

  /** The user grabbed the mouse or keyboard during raw input. The action in flight fails; later ones wait. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.rawInput = false;
    this.point = undefined;
    this.pauseTimer = setTimeout(() => this.resume(), PAUSE_EXPIRES_MS);
    this.pauseTimer.unref?.();
    this.emit();
  }

  resume(): void {
    if (!this.paused) return;
    this.clearPause();
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.detach();
      waiter.resolve();
    }
    this.emit();
  }

  /** Abort everything in flight and drop any pause. Safe to call when idle. */
  stop(): void {
    this.controller?.abort();
    const wasPaused = this.paused;
    this.clearPause();
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.detach();
      waiter.reject(new ComputerUseStoppedError());
    }
    if (wasPaused) this.emit();
  }

  private clearPause(): void {
    this.paused = false;
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }

  private waitWhilePaused(signal: AbortSignal): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(waiter);
        reject(new ComputerUseStoppedError());
      };
      const waiter: PauseWaiter = {
        resolve,
        reject,
        detach: () => signal.removeEventListener("abort", onAbort),
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  private emit(): void {
    const state = this.state();
    const key = JSON.stringify(state);
    if (key === this.lastSent) return;
    this.lastSent = key;
    for (const cb of this.listeners) {
      try {
        cb(state);
      } catch {
        // a broken listener must not break an action
      }
    }
  }
}
