import type { DeyinApi } from "@deyin/contract";
import { TEACH_LIMITS, type MessageKey, type TeachState } from "@deyin/host-core/shared";

/** The teaching calls the panel needs. Absent where there is no browser to watch. */
export type TeachApi = NonNullable<DeyinApi["botTeach"]>;

export const IDLE_TEACH: TeachState = { recording: false, steps: 0, full: false, secretsOmitted: 0 };

/** Where teaching stands for one Bot's page. */
export type TeachPhase =
  /** Nothing is recording. */
  | "idle"
  /** Recording for this Bot. */
  | "recording"
  /** Recording, but for another Bot: only one task is taught at a time. */
  | "elsewhere";

export function teachPhase(state: TeachState, botId: string): TeachPhase {
  if (!state.recording) return "idle";
  return state.botId === botId ? "recording" : "elsewhere";
}

/** The task's name is what the skill is called, so a recording needs one. */
export function canStartTeaching(title: string): boolean {
  return title.trim().length > 0;
}

export function canAddNote(text: string): boolean {
  return text.trim().length > 0;
}

export interface TeachLine {
  key: MessageKey;
  vars: Record<string, string | number>;
}

/** What to tell the person while a recording runs: how much is kept, and when nothing more will be. */
export function recordingLine(state: TeachState): TeachLine {
  if (state.full) return { key: "bot.teach.full", vars: { steps: state.steps, max: TEACH_LIMITS.steps } };
  return { key: state.steps === 1 ? "bot.teach.recordingOne" : "bot.teach.recording", vars: { steps: state.steps } };
}

/** How many things were left out because they were secret, as a line to show, or null when none were. */
export function secretsLine(state: Pick<TeachState, "secretsOmitted">): TeachLine | null {
  if (state.secretsOmitted <= 0) return null;
  return { key: state.secretsOmitted === 1 ? "bot.teach.secretOne" : "bot.teach.secrets", vars: { count: state.secretsOmitted } };
}
