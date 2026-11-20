/**
 * Holds an unattended run to its limits.
 *
 * A run nobody is watching can stall in a tool that never returns, or drift on
 * for hours; before this, the only thing that ended such a run was the user
 * noticing. `supervise` aborts a run that exceeds its wall-clock or idle limit,
 * and — because a hung tool may not honour an abort — abandons it after a grace
 * period so the scheduler slot is freed anyway.
 *
 * Pure of Electron and of real time: the clock is injected, so the limits are
 * testable without waiting.
 */

/** Why a run was cut short. `stopped` is the user (or app quit), not a failure of the run. */
export type TripReason = "timeout" | "stalled" | "stopped";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** Waits `ms` on `clock`, or less if `signal` aborts first. Never rejects. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clock.clearTimeout(handle);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const handle = clock.setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** How long an aborted run gets to wind down before it is abandoned. */
export const DEFAULT_GRACE_MS = 15_000;
/** How often the limits are checked. */
export const DEFAULT_TICK_MS = 5_000;

/** Handed to the supervised run: abort on `signal`, and call `touch` whenever it makes progress. */
export interface Supervision {
  signal: AbortSignal;
  touch(): void;
}

export interface SuperviseOptions<T> {
  limits: { maxMs: number; idleMs: number };
  /** The user's stop (or app quit). Honoured through the same grace period as a limit. */
  signal?: AbortSignal;
  graceMs?: number;
  tickMs?: number;
  clock?: Clock;
  run: (supervision: Supervision) => Promise<T>;
}

export interface Supervised<T> {
  /** Why the run was cut short; absent when it ended on its own. */
  tripped?: TripReason;
  /** What the run returned; absent when it was abandoned, or failed after being cut short. */
  value?: T;
  /** True when the run did not wind down within the grace period and was left behind. */
  abandoned: boolean;
}

type Settled<T> = { kind: "returned"; value: T } | { kind: "threw"; error: unknown } | { kind: "abandoned" };

export async function supervise<T>(opts: SuperviseOptions<T>): Promise<Supervised<T>> {
  const clock = opts.clock ?? systemClock;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const inner = new AbortController();
  const startedAt = clock.now();
  let lastActivity = startedAt;
  let tripped: TripReason | undefined;
  let tickHandle: unknown;
  let graceHandle: unknown;
  let announceTrip!: () => void;
  const trippedSignal = new Promise<void>((resolve) => {
    announceTrip = resolve;
  });

  const trip = (reason: TripReason): void => {
    if (tripped) return;
    tripped = reason;
    inner.abort();
    announceTrip();
  };

  const check = (): void => {
    if (tripped) return;
    const now = clock.now();
    if (now - startedAt >= opts.limits.maxMs) trip("timeout");
    else if (now - lastActivity >= opts.limits.idleMs) trip("stalled");
    else tickHandle = clock.setTimeout(check, tickMs);
  };

  const onUserAbort = (): void => trip("stopped");
  if (opts.signal?.aborted) trip("stopped");
  else opts.signal?.addEventListener("abort", onUserAbort, { once: true });
  if (!tripped) tickHandle = clock.setTimeout(check, tickMs);

  const finished: Promise<Settled<T>> = opts
    .run({ signal: inner.signal, touch: () => void (lastActivity = clock.now()) })
    .then(
      (value): Settled<T> => ({ kind: "returned", value }),
      (error: unknown): Settled<T> => ({ kind: "threw", error }),
    );
  const abandoned: Promise<Settled<T>> = trippedSignal.then(
    () =>
      new Promise<Settled<T>>((resolve) => {
        graceHandle = clock.setTimeout(() => resolve({ kind: "abandoned" }), graceMs);
      }),
  );

  try {
    const settled = await Promise.race([finished, abandoned]);
    if (settled.kind === "returned") return { tripped, value: settled.value, abandoned: false };
    if (settled.kind === "abandoned") return { tripped, abandoned: true };
    // A run that fails because it was aborted is the trip, not a separate error.
    if (tripped) return { tripped, abandoned: false };
    throw settled.error;
  } finally {
    if (tickHandle !== undefined) clock.clearTimeout(tickHandle);
    if (graceHandle !== undefined) clock.clearTimeout(graceHandle);
    opts.signal?.removeEventListener("abort", onUserAbort);
  }
}
