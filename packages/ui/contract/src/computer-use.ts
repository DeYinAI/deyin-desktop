import type { ComputerUseState } from "./ipc.js";

/** The chord that stops computer use from anywhere on the desktop (registered only while it is running). */
export const COMPUTER_USE_STOP_CHORD_LABEL = "Ctrl+Alt+Shift+Esc";

/** `notepad.exe` → `Notepad`. Process names are lowercase and carry no spaces, so this is only a nicer label. */
export function computerUseAppName(app: string | undefined): string {
  const base = (app ?? "").replace(/\.exe$/i, "").trim();
  if (!base) return "";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** One line for the overlay pill and the in-app banner. Empty when nothing is running. */
export function computerUsePhaseLabel(state: ComputerUseState): string {
  switch (state.phase) {
    case "idle":
      return "";
    case "background": {
      const app = computerUseAppName(state.app);
      return app ? `Deyin is working in ${app}` : "Deyin is working on your computer";
    }
    case "input":
      return "Deyin is controlling your computer";
    case "paused":
      return "You took over. Resume Deyin?";
    default: {
      const unreachable: never = state.phase;
      return unreachable;
    }
  }
}

/** True when the real mouse and keyboard are, or were just, in use: the states that deserve a loud indicator. */
export function computerUseIsLoud(state: ComputerUseState): boolean {
  return state.phase === "input" || state.phase === "paused";
}
