import type { UpdatesState } from "@deyin/contract";

/**
 * How long the in-app "Installing…" screen stays up before the app hands off to
 * the installer. The hand-off quits the app within ~20 ms, so without this pause
 * the screen would never actually be painted.
 */
export const INSTALL_HANDOFF_DELAY_MS = 1_200;

/**
 * Once handed off, the app quits on its own (and on Windows the installer
 * force-closes it after a few seconds). Still being alive this long afterwards
 * means the hand-off failed, and the UI must not sit on "Installing…" forever.
 */
export const INSTALL_STALL_TIMEOUT_MS = 30_000;

export const INSTALL_STALLED_MESSAGE = "The installer did not start. Quit and reopen Deyin to try again.";

export interface InstallTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: InstallTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface InstallFlowDeps {
  getState(): UpdatesState;
  setState(patch: Partial<UpdatesState>): void;
  /** Spawns the installer and quits the app (electron-updater's `quitAndInstall`). */
  handOff(): void;
  log(message: string): void;
  /** Timer seam so tests can drive the clock; defaults to the global timers. */
  timers?: InstallTimers;
}

export interface InstallFlow {
  /**
   * Start installing a downloaded update: publish the "installing" state right
   * away, then hand off to the installer after a short pause. Returns false (and
   * does nothing) in any other state, which also makes a double click harmless.
   */
  begin(): boolean;
  /** Route an updater error. Returns true when it aborted an install in progress. */
  handleError(err: Error): boolean;
}

export function createInstallFlow(deps: InstallFlowDeps): InstallFlow {
  const timers = deps.timers ?? REAL_TIMERS;
  let handOffTimer: unknown = null;
  let stallTimer: unknown = null;

  const cancelTimers = (): void => {
    if (handOffTimer !== null) timers.clear(handOffTimer);
    if (stallTimer !== null) timers.clear(stallTimer);
    handOffTimer = null;
    stallTimer = null;
  };

  const fail = (message: string): void => {
    cancelTimers();
    deps.log(`install failed: ${message}`);
    deps.setState({ status: "error", error: message });
  };

  const runHandOff = (): void => {
    handOffTimer = null;
    if (deps.getState().status !== "installing") return;
    deps.log("install: handing off to the installer");
    try {
      deps.handOff();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    stallTimer = timers.set(() => {
      stallTimer = null;
      if (deps.getState().status === "installing") fail(INSTALL_STALLED_MESSAGE);
    }, INSTALL_STALL_TIMEOUT_MS);
  };

  return {
    begin() {
      const state = deps.getState();
      if (state.status !== "downloaded") return false;
      deps.log(`install: starting (version ${state.availableVersion ?? "unknown"})`);
      deps.setState({ status: "installing", error: undefined });
      handOffTimer = timers.set(runHandOff, INSTALL_HANDOFF_DELAY_MS);
      return true;
    },
    handleError(err) {
      if (deps.getState().status !== "installing") return false;
      fail(err.message);
      return true;
    },
  };
}
