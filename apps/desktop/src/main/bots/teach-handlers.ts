import {
  BotError,
  TEACH_LIMITS,
  TeachRecorder,
  botResult,
  botResultAsync,
  cleanBotLine,
  draftSkillFromRecording,
  teachStepSentence,
  type BotResult,
  type BotSkill,
  type BotSkillInput,
  type BotStore,
  type TeachDraft,
  type TeachEvent,
  type TeachState,
} from "@deyin/host-core";
import type { CaptureHandle } from "./teach-capture.js";
import type { BotSkillStores } from "./skills-handlers.js";

export interface TeachHandlerDeps {
  store: Pick<BotStore, "get">;
  stores: BotSkillStores;
  /** Makes the thing that watches the browser, sending each event to the function it is given. */
  capture(onEvent: (event: TeachEvent) => void): CaptureHandle;
  now?: () => number;
  /** Called whenever the state changes: a step was kept, recording began or ended. */
  onChange?(state: TeachState): void;
  /** Called after a taught skill was saved to a Bot, so what keeps a copy of the Bot's skills can be brought up to date. */
  saved?(botId: string): void;
}

export interface TeachHandlers {
  state(): TeachState;
  start(botId: unknown, title: unknown): Promise<BotResult<TeachState>>;
  /** Add something the person says while they work ("wait for the download"). */
  note(text: unknown): BotResult<TeachState>;
  /** End the recording and draft a skill from it. Nothing is saved: the person reads the draft first. */
  stop(options?: unknown): Promise<BotResult<TeachDraft>>;
  /** Throw the recording away. */
  cancel(): Promise<BotResult<TeachState>>;
  /** Save a draft the person has read and changed, under a name no other skill of the Bot has. */
  save(botId: unknown, skill: unknown): Promise<BotResult<BotSkill>>;
}

const IDLE: TeachState = { recording: false, steps: 0, full: false, secretsOmitted: 0 };

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new BotError("invalid", `${what} must be text.`);
  return value;
};

interface Session {
  botId: string;
  title: string;
  recorder: TeachRecorder;
  capture: CaptureHandle;
}

/**
 * One teaching session at a time, in this window: start it for a Bot, do the task in the browser, stop, read the
 * drafted skill, save it. A session is only a recording held in memory until it is stopped; stopping or cancelling it
 * lets go of everything.
 */
export function createTeachHandlers(deps: TeachHandlerDeps): TeachHandlers {
  const now = deps.now ?? Date.now;
  let session: Session | null = null;

  const view = (current: Session | null): TeachState => {
    if (!current) return IDLE;
    const snapshot = current.recorder.snapshot();
    const last = snapshot.steps.at(-1);
    return {
      recording: true,
      botId: current.botId,
      title: current.title,
      steps: snapshot.steps.length,
      full: current.recorder.full,
      secretsOmitted: snapshot.secretsOmitted,
      ...(last ? { last: teachStepSentence(last) } : {}),
    };
  };
  const changed = (): void => {
    try {
      deps.onChange?.(view(session));
    } catch {
      // Telling the window is not part of recording.
    }
  };
  const end = async (current: Session): Promise<void> => {
    if (session === current) session = null;
    await current.capture.stop();
  };

  return {
    state: () => view(session),

    start: (botId, title) =>
      botResultAsync(async () => {
        const id = text(botId, "The Bot id");
        const bot = deps.store.get(id);
        if (!bot) throw new BotError("not_found", "That Bot no longer exists.");
        if (bot.kind === "room") throw new BotError("invalid", `${bot.name} is a room. Teach one of its Bots instead.`);
        if (session) throw new BotError("conflict", "A recording is already running. Stop it, or cancel it, first.");
        const name = cleanBotLine(text(title, "The name of the task")).slice(0, TEACH_LIMITS.title);
        if (!name) throw new BotError("invalid", "Say what the task is called, for example \"Download the weekly report\".");
        const recorder = new TeachRecorder(name, now(), now);
        const capture = deps.capture((event) => {
          if (session?.recorder === recorder && recorder.add(event)) changed();
        });
        // Taking the place before the page is watched, so a second start in this moment is refused rather than doubled.
        const current: Session = { botId: id, title: name, recorder, capture };
        session = current;
        try {
          capture.start();
        } catch (error) {
          if (session === current) session = null;
          throw error;
        }
        changed();
        return view(current);
      }),

    note: (value) =>
      botResult(() => {
        if (!session) throw new BotError("conflict", "There is no recording to add a note to.");
        const noted = cleanBotLine(text(value, "The note"));
        if (!noted) throw new BotError("invalid", "Write the note first.");
        if (session.recorder.add({ kind: "note", text: noted })) changed();
        return view(session);
      }),

    stop: (options) =>
      botResultAsync(async () => {
        const current = session;
        if (!current) throw new BotError("conflict", "There is no recording to stop.");
        const choices = options === undefined || options === null ? {} : (options as Record<string, unknown>);
        if (typeof choices !== "object" || Array.isArray(choices)) throw new BotError("invalid", "The choices must be an object.");
        await end(current);
        const recording = current.recorder.stop();
        const draft = draftSkillFromRecording(recording, {
          ...(typeof choices.name === "string" && choices.name.trim() ? { name: choices.name } : {}),
          ...(typeof choices.description === "string" && choices.description.trim() ? { description: choices.description } : {}),
        });
        changed();
        return { skill: draft.skill, warnings: draft.warnings, steps: recording.steps.length };
      }),

    cancel: () =>
      botResultAsync(async () => {
        const current = session;
        if (current) await end(current);
        changed();
        return IDLE;
      }),

    save: (botId, skill) =>
      botResultAsync(async () => {
        const store = deps.stores.of(botId);
        const wanted = skill as Partial<BotSkillInput> | null;
        if (typeof wanted !== "object" || wanted === null || Array.isArray(wanted)) throw new BotError("invalid", "The skill is not in a form this app understands.");
        // The free name is chosen as the skill is written, so a skill saved in the Skills panel a moment ago is never overwritten.
        const saved = await store.saveUnique(wanted, { author: "person", origin: "recording" });
        try {
          deps.saved?.(botId as string);
        } catch {
          // Telling others is not part of the save: the skill is already kept.
        }
        return saved;
      }),
  };
}
