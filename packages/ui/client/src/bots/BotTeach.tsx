import { useEffect, useRef, useState, type FormEvent } from "react";
import { TEACH_LIMITS, type BotSkillInput, type DeyinBot, type TeachState } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { attempt, attemptPlain, type Outcome } from "./botCalls.js";
import { IDLE_TEACH, canAddNote, canStartTeaching, recordingLine, secretsLine, teachPhase, type TeachApi } from "./botTeach.js";

/** What was said about the draft the last recording made, shown until the next one starts. */
export interface TeachResult {
  steps: number;
  warnings: string[];
}

interface BotTeachPanelProps {
  phase: ReturnType<typeof teachPhase>;
  state: TeachState;
  title: string;
  note: string;
  busy: boolean;
  error: string | null;
  result: TeachResult | null;
  onTitle: (title: string) => void;
  onNote: (note: string) => void;
  onStart: () => void;
  onAddNote: () => void;
  onStop: () => void;
  onCancel: () => void;
}

/** The teach section as pure markup: start, watch it keep steps, say something, stop. */
export function BotTeachPanel(props: BotTeachPanelProps) {
  const { phase, state, busy } = props;
  const t = useT();
  const line = recordingLine(state);
  const secrets = secretsLine(state);
  const start = (event: FormEvent): void => {
    event.preventDefault();
    props.onStart();
  };
  const addNote = (event: FormEvent): void => {
    event.preventDefault();
    props.onAddNote();
  };
  return (
    <div className="bot-panel__teach" role="region" aria-label={t("bot.teach.title")}>
      <h4 className="bot-detail__subheading">{t("bot.teach.title")}</h4>
      <p className="hint">{t("bot.teach.hint")}</p>
      {props.error ? (
        <p className="hint--bad" role="alert">
          {props.error}
        </p>
      ) : null}
      {phase === "idle" ? (
        <form className="bot-panel__editor" onSubmit={start} aria-label={t("bot.teach.start")}>
          <div className="field">
            <label className="field__label" htmlFor="teach-title">
              {t("bot.teach.task")}
            </label>
            <input id="teach-title" className="input" value={props.title} maxLength={TEACH_LIMITS.label} disabled={busy} autoComplete="off" placeholder={t("bot.teach.taskPlaceholder")} onChange={(event) => props.onTitle(event.target.value)} />
          </div>
          <div className="bot-panel__buttons">
            <button type="submit" className="btn btn--outline" disabled={busy || !canStartTeaching(props.title)}>
              {t("bot.teach.start")}
            </button>
          </div>
        </form>
      ) : null}
      {phase === "recording" ? (
        <div className="bot-panel__editor">
          <p className="bot-panel__recording" role="status">
            <span className="bot-panel__dot" aria-hidden="true" />
            {fill(t(line.key), line.vars)}
          </p>
          {state.last ? <p className="hint">{fill(t("bot.teach.last"), { step: state.last })}</p> : null}
          {secrets ? <p className="hint">{fill(t(secrets.key), secrets.vars)}</p> : null}
          <form className="bot-panel__note" onSubmit={addNote}>
            <label className="field__label" htmlFor="teach-note">
              {t("bot.teach.noteLabel")}
            </label>
            <input id="teach-note" className="input" value={props.note} maxLength={TEACH_LIMITS.text} disabled={busy} autoComplete="off" placeholder={t("bot.teach.notePlaceholder")} onChange={(event) => props.onNote(event.target.value)} />
            <button type="submit" className="btn btn--ghost" disabled={busy || !canAddNote(props.note)}>
              {t("bot.teach.addNote")}
            </button>
          </form>
          <div className="bot-panel__buttons">
            <button type="button" className="btn btn--outline btn--danger" disabled={busy} onClick={props.onCancel}>
              {t("bot.teach.cancel")}
            </button>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={props.onStop}>
              {t("bot.teach.stop")}
            </button>
          </div>
        </div>
      ) : null}
      {phase === "elsewhere" ? <p className="hint">{t("bot.teach.elsewhere")}</p> : null}
      {props.result && phase !== "recording" ? (
        <div role="status">
          <p className="hint">{fill(t("bot.teach.drafted"), { steps: props.result.steps })}</p>
          {props.result.warnings.map((warning) => (
            <p key={warning} className="hint--bad">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface BotTeachProps {
  bot: DeyinBot;
  api: TeachApi;
  /** A skill was drafted from the recording; the person reads and changes it before it is saved. */
  onDraft: (draft: BotSkillInput) => void;
}

/** Teach a Bot a task by doing it in the browser. */
export function BotTeach({ bot, api, onDraft }: BotTeachProps) {
  const t = useT();
  const { confirm } = useConfirm();
  const [state, setState] = useState<TeachState>(IDLE_TEACH);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TeachResult | null>(null);
  const mounted = useRef(true);
  /** Counts what the host has told us, so a slow first answer cannot replace a newer push. */
  const pushes = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const seen = pushes.current;
    const stop = api.onChange((next) => {
      pushes.current += 1;
      setState(next);
    });
    void attemptPlain(() => api.state()).then((outcome) => {
      if (mounted.current && outcome.ok && pushes.current === seen) setState(outcome.value);
    });
    return stop;
  }, [api]);

  const run = async <T,>(call: () => Promise<Outcome<T>>): Promise<Outcome<T>> => {
    setBusy(true);
    setError(null);
    const outcome = await call();
    if (mounted.current) {
      setBusy(false);
      if (!outcome.ok) setError(outcome.error);
    }
    return outcome;
  };

  const start = async (): Promise<void> => {
    if (!canStartTeaching(title)) return;
    const outcome = await run(() => attempt(() => api.start(bot.id, title.trim())));
    if (outcome.ok && mounted.current) {
      setState(outcome.value);
      setResult(null);
      setNote("");
    }
  };

  const addNote = async (): Promise<void> => {
    if (!canAddNote(note)) return;
    const outcome = await run(() => attempt(() => api.note(note.trim())));
    if (outcome.ok && mounted.current) {
      setState(outcome.value);
      setNote("");
    }
  };

  const stop = async (): Promise<void> => {
    const outcome = await run(() => attempt(() => api.stop()));
    if (!outcome.ok || !mounted.current) return;
    setResult({ steps: outcome.value.steps, warnings: outcome.value.warnings });
    setState(IDLE_TEACH);
    setTitle("");
    setNote("");
    onDraft(outcome.value.skill);
  };

  const cancel = async (): Promise<void> => {
    if (state.steps > 0) {
      const accepted = await confirm({ message: t("bot.teach.cancelMessage"), confirmLabel: t("bot.teach.discard"), destructive: true });
      if (!accepted) return;
    }
    const outcome = await run(() => attempt(() => api.cancel()));
    if (outcome.ok && mounted.current) {
      setState(outcome.value);
      setResult(null);
    }
  };

  return (
    <BotTeachPanel
      phase={teachPhase(state, bot.id)}
      state={state}
      title={title}
      note={note}
      busy={busy}
      error={error}
      result={result}
      onTitle={setTitle}
      onNote={setNote}
      onStart={() => void start()}
      onAddNote={() => void addNote()}
      onStop={() => void stop()}
      onCancel={() => void cancel()}
    />
  );
}
