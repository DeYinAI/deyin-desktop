import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { SKILL_LIMITS, type BotSkillSummary, type DeyinBot } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { attempt } from "./botCalls.js";
import { BotTeach } from "./BotTeach.js";
import type { TeachApi } from "./botTeach.js";
import {
  emptySkillForm,
  isSkillFormDirty,
  originKey,
  revisionRows,
  skillFormFromDraft,
  skillFormFromSkill,
  skillFormProblem,
  skillPayload,
  type RevisionRow,
  type SkillForm,
  type SkillsApi,
} from "./botSkills.js";

export type SkillsState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; skills: BotSkillSummary[] };

export interface SkillEditor {
  form: SkillForm;
  /** Where the words came from: typed here, or drafted from a recording the person taught. */
  source: "person" | "recording";
  busy: boolean;
  error: string | null;
}

export interface SkillHistory {
  skill: string;
  rows: RevisionRow[];
  busy: boolean;
  error: string | null;
}

interface BotSkillsPanelProps {
  state: SkillsState;
  notice: string | null;
  editor: SkillEditor | null;
  history: SkillHistory | null;
  /** Taught tasks, put under the list by the caller. */
  children?: ReactNode;
  onNew: () => void;
  onEdit: (name: string) => void;
  onRemove: (name: string) => void;
  onHistory: (name: string) => void;
  onRevert: (revisionId: string) => void;
  onCloseHistory: () => void;
  onChangeForm: (patch: Partial<SkillForm>) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** The skills section as pure markup, so every state can be rendered without a host. */
export function BotSkillsPanel(props: BotSkillsPanelProps) {
  const { state, notice, editor, history } = props;
  const t = useT();
  return (
    <section className="bot-panel" aria-label={t("bot.skills.title")}>
      <h3 className="bot-detail__heading">{t("bot.skills.title")}</h3>
      <p className="hint">{t("bot.skills.hint")}</p>
      {notice ? (
        <p className="hint--bad" role="alert">
          {notice}
        </p>
      ) : null}
      {state.status === "loading" ? (
        <p className="hint" role="status">
          {t("bot.skills.loading")}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="hint--bad" role="alert">
          {t("bot.skills.loadError")} {state.error}
        </p>
      ) : null}
      {state.status === "ready" && state.skills.length === 0 ? <p className="hint">{t("bot.skills.empty")}</p> : null}
      {state.status === "ready" && state.skills.length > 0 ? (
        <ul className="bot-panel__list">
          {state.skills.map((skill) => (
            <li key={skill.name} className="bot-panel__item">
              <div className="bot-panel__main">
                <strong className="bot-panel__name">{skill.name}</strong>
                <span className="bot-panel__meta">{skill.description}</span>
                <span className="bot-panel__badge">{`${t(originKey(skill.origin))} · ${fill(t("bot.skills.version"), { version: skill.version })}`}</span>
              </div>
              <div className="bot-panel__actions">
                <button type="button" className="btn btn--ghost" onClick={() => props.onEdit(skill.name)}>
                  {t("bot.skills.edit")}
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => props.onHistory(skill.name)}>
                  {t("bot.skills.history")}
                </button>
                <button type="button" className="btn btn--ghost btn--danger" onClick={() => props.onRemove(skill.name)}>
                  {t("bot.skills.remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {state.status === "ready" && !editor ? (
        state.skills.length >= SKILL_LIMITS.perBot ? (
          <p className="hint">{fill(t("bot.skills.limit"), { limit: SKILL_LIMITS.perBot })}</p>
        ) : (
          <button type="button" className="btn btn--outline" onClick={props.onNew}>
            {t("bot.skills.new")}
          </button>
        )
      ) : null}
      {editor ? <SkillEditorForm editor={editor} onChange={props.onChangeForm} onSave={props.onSave} onCancel={props.onCancel} /> : null}
      {history ? <SkillHistoryList history={history} onRevert={props.onRevert} onClose={props.onCloseHistory} /> : null}
      {props.children}
    </section>
  );
}

function SkillEditorForm({ editor, onChange, onSave, onCancel }: { editor: SkillEditor; onChange: (patch: Partial<SkillForm>) => void; onSave: () => void; onCancel: () => void }) {
  const t = useT();
  const { form } = editor;
  const adding = form.version === null;
  const problem = skillFormProblem(form);
  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      onSave();
    },
    [onSave],
  );
  return (
    <form className="bot-panel__editor" onSubmit={submit} aria-label={adding ? t("bot.skills.new") : fill(t("bot.skills.editing"), { name: form.name })}>
      <div className="field">
        <label className="field__label" htmlFor="skill-name">
          {t("bot.skills.name")}
        </label>
        <input id="skill-name" className="input" value={form.name} maxLength={SKILL_LIMITS.name} readOnly={!adding} disabled={editor.busy} autoComplete="off" aria-describedby="skill-name-hint" onChange={(event) => onChange({ name: event.target.value })} />
        <span id="skill-name-hint" className="hint">
          {t(adding ? "bot.skills.nameHint" : "bot.skills.nameFixed")}
        </span>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="skill-description">
          {t("bot.skills.description")}
        </label>
        <input id="skill-description" className="input" value={form.description} maxLength={SKILL_LIMITS.description} disabled={editor.busy} autoComplete="off" onChange={(event) => onChange({ description: event.target.value })} />
        <span className="hint">{t("bot.skills.descriptionHint")}</span>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="skill-body">
          {t("bot.skills.body")}
        </label>
        <textarea id="skill-body" className="input bot-panel__code" rows={10} value={form.body} maxLength={SKILL_LIMITS.body} disabled={editor.busy} placeholder={t("bot.skills.bodyPlaceholder")} onChange={(event) => onChange({ body: event.target.value })} />
      </div>
      {editor.error ? (
        <p className="hint--bad" role="alert">
          {editor.error}
        </p>
      ) : problem && isSkillFormDirty(null, form) ? (
        <p className="hint--bad" role="status">
          {t(problem)}
        </p>
      ) : null}
      <div className="bot-panel__buttons">
        <button type="button" className="btn btn--outline" disabled={editor.busy} onClick={onCancel}>
          {t("bot.skills.cancel")}
        </button>
        <button type="submit" className="btn btn--primary" disabled={editor.busy || problem !== null}>
          {t(editor.busy ? "bot.skills.saving" : "bot.skills.save")}
        </button>
      </div>
    </form>
  );
}

function SkillHistoryList({ history, onRevert, onClose }: { history: SkillHistory; onRevert: (id: string) => void; onClose: () => void }) {
  const t = useT();
  return (
    <div className="bot-panel__editor" role="region" aria-label={fill(t("bot.skills.historyOf"), { name: history.skill })}>
      <h4 className="bot-detail__subheading">{fill(t("bot.skills.historyOf"), { name: history.skill })}</h4>
      {history.error ? (
        <p className="hint--bad" role="alert">
          {history.error}
        </p>
      ) : null}
      <ul className="bot-panel__list">
        {history.rows.map((row) => (
          <li key={row.id} className="bot-panel__item">
            <div className="bot-panel__main">
              <strong className="bot-panel__name">{fill(t("bot.skills.version"), { version: row.version })}</strong>
              <span className="bot-panel__meta">
                {`${t(row.author === "bot" ? "bot.skills.author.bot" : "bot.skills.author.person")} · ${new Date(row.at).toLocaleString()}`}
              </span>
              {row.created ? <span className="bot-panel__badge">{t("bot.skills.created")}</span> : null}
              {row.rolledBack ? <span className="bot-panel__badge">{t("bot.skills.rolledBack")}</span> : null}
              {row.current ? <span className="bot-panel__badge">{t("bot.skills.currentVersion")}</span> : null}
            </div>
            <div className="bot-panel__actions">
              <button type="button" className="btn btn--ghost" disabled={row.current || history.busy} onClick={() => onRevert(row.id)}>
                {t("bot.skills.putBack")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="bot-panel__buttons">
        <button type="button" className="btn btn--outline" onClick={onClose}>
          {t("bot.skills.closeHistory")}
        </button>
      </div>
    </div>
  );
}

interface BotSkillsProps {
  bot: DeyinBot;
  api: SkillsApi;
  /** Teaching by showing; absent where there is no browser to watch, which hides it. */
  teach?: TeachApi;
}

/** A Bot's skills: what it knows how to do, in words it reads when a task calls for it. */
export function BotSkills({ bot, api, teach }: BotSkillsProps) {
  const t = useT();
  const { confirm } = useConfirm();
  const [skills, setSkills] = useState<BotSkillSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<SkillEditor | null>(null);
  const [history, setHistory] = useState<SkillHistory | null>(null);
  const mounted = useRef(true);
  /** Counts loads, so a slow answer cannot replace a newer one. */
  const loads = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    loads.current += 1;
    const mine = loads.current;
    const outcome = await attempt(() => api.list(bot.id));
    if (!mounted.current || mine !== loads.current) return;
    if (outcome.ok) {
      setSkills(outcome.value);
      setLoadError(null);
    } else {
      setLoadError(outcome.error);
    }
  }, [api, bot.id]);

  useEffect(() => {
    setSkills(null);
    setLoadError(null);
    setEditor(null);
    setHistory(null);
    void load();
    // A skill changed in another window, taught, or imported shows up without a refresh.
    return api.onChange((botId) => {
      if (botId === bot.id) void load();
    });
  }, [api, bot.id, load]);

  const state: SkillsState = loadError ? { status: "error", error: loadError } : skills === null ? { status: "loading" } : { status: "ready", skills };

  const edit = async (name: string): Promise<void> => {
    setNotice(null);
    const outcome = await attempt(() => api.get(bot.id, name));
    if (!mounted.current) return;
    if (outcome.ok) setEditor({ form: skillFormFromSkill(outcome.value), source: "person", busy: false, error: null });
    else setNotice(outcome.error);
  };

  const save = async (): Promise<void> => {
    if (!editor || editor.busy || skillFormProblem(editor.form) !== null) return;
    const { form, source } = editor;
    setEditor({ ...editor, busy: true, error: null });
    const payload = skillPayload(form);
    // A taught skill takes a name no other skill has; one the person writes or changes keeps the name it has.
    const outcome = await attempt(() => (source === "recording" && teach ? teach.save(bot.id, payload) : api.save(bot.id, payload, form.version ?? undefined)));
    if (!mounted.current) return;
    if (outcome.ok) {
      setEditor(null);
      void load();
    } else {
      setEditor((current) => (current ? { ...current, busy: false, error: outcome.error } : current));
    }
  };

  const remove = async (name: string): Promise<void> => {
    const accepted = await confirm({ title: name, message: t("bot.skills.removeMessage"), confirmLabel: t("bot.skills.remove"), destructive: true });
    if (!accepted) return;
    const outcome = await attempt(() => api.remove(bot.id, name));
    if (!mounted.current) return;
    if (!outcome.ok) {
      setNotice(outcome.error);
      return;
    }
    setNotice(null);
    setEditor((current) => (current && current.form.name === name && current.form.version !== null ? null : current));
    setHistory((current) => (current?.skill === name ? null : current));
    void load();
  };

  const showHistory = async (name: string): Promise<void> => {
    setNotice(null);
    const outcome = await attempt(() => api.revisions(bot.id, name));
    if (!mounted.current) return;
    if (outcome.ok) setHistory({ skill: name, rows: revisionRows(outcome.value), busy: false, error: null });
    else setNotice(outcome.error);
  };

  const revert = async (revisionId: string): Promise<void> => {
    if (!history || history.busy) return;
    const name = history.skill;
    setHistory({ ...history, busy: true, error: null });
    const outcome = await attempt(() => api.revert(bot.id, name, revisionId));
    if (!mounted.current) return;
    if (!outcome.ok) {
      setHistory((current) => (current ? { ...current, busy: false, error: outcome.error } : current));
      return;
    }
    // What the skill said when the form was opened is no longer what it says.
    setEditor((current) => (current && current.form.name === name && current.form.version !== null ? null : current));
    void load();
    await showHistory(name);
  };

  return (
    <BotSkillsPanel
      state={state}
      notice={notice}
      editor={editor}
      history={history}
      onNew={() => {
        setNotice(null);
        setEditor({ form: emptySkillForm(), source: "person", busy: false, error: null });
      }}
      onEdit={(name) => void edit(name)}
      onRemove={(name) => void remove(name)}
      onHistory={(name) => void showHistory(name)}
      onRevert={(id) => void revert(id)}
      onCloseHistory={() => setHistory(null)}
      onChangeForm={(patch) => setEditor((current) => (current ? { ...current, error: null, form: { ...current.form, ...patch } } : current))}
      onSave={() => void save()}
      onCancel={() => setEditor(null)}
    >
      {teach ? (
        <BotTeach
          bot={bot}
          api={teach}
          onDraft={(draft) => {
            setNotice(null);
            setEditor({ form: skillFormFromDraft(draft), source: "recording", busy: false, error: null });
          }}
        />
      ) : null}
    </BotSkillsPanel>
  );
}
