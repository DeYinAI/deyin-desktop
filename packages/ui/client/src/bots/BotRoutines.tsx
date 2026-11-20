import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AutomationInfo } from "@deyin/contract";
import { ROUTINE_LIMITS, automationStatus, type DeyinBot } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { describeSchedule, fill } from "../automationFormat.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { ScheduleRows } from "../components/ScheduleRows.js";
import { Toggle } from "../components/settings/controls.js";
import { routineServerLine } from "./botServers.js";
import {
  addBlockFor,
  attemptRoutineAction,
  emptyRoutineForm,
  isEditableRoutine,
  routineFormFromInfo,
  routineHint,
  routineProblem,
  routineRows,
  saveRoutine,
  type AddBlock,
  type RoutineDefaults,
  type RoutineForm,
  type RoutinesApi,
} from "./botRoutines.js";

export type RoutinesState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; rows: AutomationInfo[]; addBlock: AddBlock };

export interface RoutineEditor {
  /** The routine being changed, or null for a new one. */
  id: string | null;
  form: RoutineForm;
  busy: boolean;
  error: string | null;
}

const ADD_BLOCK_KEY = {
  limit: "bot.routines.limit",
  archived: "bot.routines.archived",
  noModel: "bot.routines.noModel",
} as const;

interface BotRoutinesProps {
  bot: DeyinBot;
  api: RoutinesApi;
  defaults: RoutineDefaults;
}

/** A Bot's routines: what it does on a schedule or when asked. They are automations the Bot owns, so they run, pause and keep records like any other. */
export function BotRoutines({ bot, api, defaults }: BotRoutinesProps) {
  const t = useT();
  const { confirm } = useConfirm();
  const [list, setList] = useState<AutomationInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [editor, setEditor] = useState<RoutineEditor | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setList(null);
    setLoadError(null);
    // Where a routine runs can change without the person touching it (a server answers again, a Bot moves), so the host's changes are followed.
    const stop = api.onChange?.((next) => {
      if (current) setList(next);
    });
    void attemptRoutineAction(() => api.list()).then((outcome) => {
      if (!current) return;
      // A change that arrived while loading is newer than the answer.
      if (outcome.ok) setList((existing) => existing ?? outcome.list ?? []);
      else setLoadError(outcome.error);
    });
    return () => {
      current = false;
      stop?.();
    };
  }, [api, bot.id]);

  const state: RoutinesState = loadError
    ? { status: "error", error: loadError }
    : list === null
      ? { status: "loading" }
      : { status: "ready", rows: routineRows(list, bot.id), addBlock: addBlockFor(list, bot, defaults) };

  /** Run one call, show a refusal as text, and take the list it returns. */
  const act = async (run: () => Promise<unknown>, onDone?: () => void): Promise<void> => {
    const outcome = await attemptRoutineAction(run);
    if (!mounted.current) return;
    setInfo(null);
    if (!outcome.ok) {
      setNotice(outcome.error);
      return;
    }
    setNotice(null);
    if (outcome.list) setList(outcome.list);
    onDone?.();
  };

  const remove = async (row: AutomationInfo): Promise<void> => {
    const accepted = await confirm({
      title: row.name,
      message: t("bot.routines.deleteMessage"),
      confirmLabel: t("bot.routines.delete"),
      destructive: true,
    });
    if (!accepted) return;
    if (editor?.id === row.id) setEditor(null);
    await act(() => api.remove(row.id));
  };

  const save = async (): Promise<void> => {
    if (!editor || editor.busy || routineProblem(editor.form, Date.now())) return;
    const form = editor.form;
    const existing = editor.id ? (list?.find((row) => row.id === editor.id) ?? null) : null;
    setEditor({ ...editor, busy: true, error: null });
    const outcome = await saveRoutine(api, bot.id, form, existing, defaults);
    if (!mounted.current) return;
    if (outcome.ok) {
      setList(outcome.list);
      setNotice(null);
      setEditor(null);
    } else {
      setEditor((current) => (current ? { ...current, busy: false, error: outcome.error } : current));
    }
  };

  return (
    <BotRoutinesPanel
      state={state}
      notice={notice}
      info={info}
      editor={editor}
      now={now}
      onNew={() => {
        setNow(Date.now());
        setNotice(null);
        setInfo(null);
        setEditor({ id: null, form: emptyRoutineForm(new Date()), busy: false, error: null });
      }}
      onEdit={(row) => {
        setNow(Date.now());
        setNotice(null);
        setInfo(null);
        setEditor({ id: row.id, form: routineFormFromInfo(row), busy: false, error: null });
      }}
      onToggle={(row) => void act(() => api.toggle(row.id, !row.enabled))}
      onTest={(row) =>
        void act(
          () => api.run(row.id),
          () => setInfo(t("bot.routines.testStarted")),
        )
      }
      onDelete={(row) => void remove(row)}
      onChangeForm={(patch) => setEditor((current) => (current ? { ...current, error: null, form: { ...current.form, ...patch } } : current))}
      onSave={() => void save()}
      onCancel={() => setEditor(null)}
    />
  );
}

interface BotRoutinesPanelProps {
  state: RoutinesState;
  notice: string | null;
  info: string | null;
  editor: RoutineEditor | null;
  /** The current time, for the editor's time-zone row and past-date check. */
  now: number;
  onNew: () => void;
  onEdit: (row: AutomationInfo) => void;
  onToggle: (row: AutomationInfo) => void;
  onTest: (row: AutomationInfo) => void;
  onDelete: (row: AutomationInfo) => void;
  onChangeForm: (patch: Partial<RoutineForm>) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** The routines section as pure markup, so every state can be rendered without a host. */
export function BotRoutinesPanel(props: BotRoutinesPanelProps) {
  const { state, notice, info, editor, now } = props;
  const t = useT();

  const statusLabel = (row: AutomationInfo): string | null => {
    const status = automationStatus(row);
    if (status === "paused") return t("bot.routines.paused");
    if (status === "ended") return t("bot.routines.ended");
    return null;
  };

  return (
    <section className="bot-routines" aria-label={t("bot.routines.title")}>
      <h3 className="bot-detail__heading">{t("bot.routines.title")}</h3>
      <p className="hint">{t("bot.routines.hint")}</p>
      {notice ? (
        <p className="hint--bad" role="alert">
          {notice}
        </p>
      ) : null}
      {info ? (
        <p className="hint" role="status">
          {info}
        </p>
      ) : null}
      {state.status === "loading" ? (
        <p className="hint" role="status">
          {t("bot.routines.loading")}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="hint--bad" role="alert">
          {t("bot.routines.loadError")} {state.error}
        </p>
      ) : null}
      {state.status === "ready" && state.rows.length === 0 ? <p className="hint">{t("bot.routines.empty")}</p> : null}
      {state.status === "ready" && state.rows.length > 0 ? (
        <ul className="bot-routines__list">
          {state.rows.map((row) => {
            const status = statusLabel(row);
            const editable = isEditableRoutine(row);
            const where = routineServerLine(row.server);
            return (
              <li key={row.id} className="bot-routine">
                <div className="bot-routine__main">
                  <strong className="bot-routine__name">{row.name}</strong>
                  <span className="bot-routine__schedule">{describeSchedule(row.trigger, t)}</span>
                  {status ? <span className="bot-routine__badge">{status}</span> : null}
                  {where ? <span className={where.tone === "ok" ? "hint" : "hint--bad"}>{fill(t(where.key), where.vars)}</span> : null}
                </div>
                <div className="bot-routine__actions">
                  <Toggle
                    checked={row.enabled}
                    onChange={() => props.onToggle(row)}
                    label={`${t(row.enabled ? "bot.routines.pause" : "bot.routines.resume")}: ${row.name}`}
                  />
                  <button type="button" className="btn btn--ghost" onClick={() => props.onTest(row)}>
                    {t("bot.routines.test")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={!editable}
                    title={editable ? undefined : t("bot.routines.editInAutomations")}
                    onClick={() => props.onEdit(row)}
                  >
                    {t("bot.routines.edit")}
                  </button>
                  <button type="button" className="btn btn--ghost btn--danger" onClick={() => props.onDelete(row)}>
                    {t("bot.routines.delete")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {state.status === "ready" && !editor ? (
        state.addBlock ? (
          <p className="hint">{state.addBlock === "limit" ? fill(t(ADD_BLOCK_KEY.limit), { limit: ROUTINE_LIMITS.perBot }) : t(ADD_BLOCK_KEY[state.addBlock])}</p>
        ) : (
          <button type="button" className="btn btn--outline" onClick={props.onNew}>
            {t("bot.routines.new")}
          </button>
        )
      ) : null}
      {editor ? <RoutineEditorForm editor={editor} now={now} onChange={props.onChangeForm} onSave={props.onSave} onCancel={props.onCancel} /> : null}
    </section>
  );
}

interface RoutineEditorFormProps {
  editor: RoutineEditor;
  now: number;
  onChange: (patch: Partial<RoutineForm>) => void;
  onSave: () => void;
  onCancel: () => void;
}

function RoutineEditorForm({ editor, now, onChange, onSave, onCancel }: RoutineEditorFormProps) {
  const t = useT();
  const { form } = editor;
  const problem = routineProblem(form, now);
  const hint = routineHint(form, now);
  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      onSave();
    },
    [onSave],
  );
  return (
    <form className="bot-routines__editor" onSubmit={submit} aria-label={t(editor.id ? "bot.routines.edit" : "bot.routines.new")}>
      <div className="field">
        <label className="field__label" htmlFor="routine-name">
          {t("bot.routines.name")}
        </label>
        <input
          id="routine-name"
          className="input"
          value={form.name}
          maxLength={120}
          disabled={editor.busy}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="routine-instruction">
          {t("bot.routines.instruction")}
        </label>
        <textarea
          id="routine-instruction"
          className="input"
          rows={4}
          value={form.instruction}
          placeholder={t("bot.routines.instructionPlaceholder")}
          disabled={editor.busy}
          onChange={(event) => onChange({ instruction: event.target.value })}
        />
      </div>
      <div className="rule-rows">
        <ScheduleRows schedule={form.schedule} onChange={(patch) => onChange({ schedule: { ...form.schedule, ...patch } })} now={now} idPrefix="routine" />
      </div>
      {editor.error ? (
        <p className="hint--bad" role="alert">
          {editor.error}
        </p>
      ) : hint ? (
        <p className="hint--bad" role="status">
          {t(hint)}
        </p>
      ) : null}
      <div className="bot-routines__buttons">
        <button type="button" className="btn btn--outline" disabled={editor.busy} onClick={onCancel}>
          {t("bot.routines.cancel")}
        </button>
        <button type="submit" className="btn btn--primary" disabled={editor.busy || problem !== null}>
          {t(editor.busy ? "bot.routines.saving" : "bot.routines.save")}
        </button>
      </div>
    </form>
  );
}
