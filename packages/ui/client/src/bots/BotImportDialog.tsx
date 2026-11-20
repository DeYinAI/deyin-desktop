import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DeyinBot, ImportedBot, TemplateSummary } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { attempt } from "./botCalls.js";
import type { RoutineDefaults } from "./botRoutines.js";
import { comesWithLine, importBlocked, importedLines, pastedProblem, summaryCounts, type TemplatesApi } from "./botTemplates.js";

export type ImportStep =
  /** Asking for the Bot's text or link. */
  | { step: "paste" }
  /** Showing what it carries, before anything is added. */
  | { step: "preview"; summary: TemplateSummary }
  /** Added. */
  | { step: "done"; result: ImportedBot };

interface BotImportViewProps {
  text: string;
  state: ImportStep;
  busy: boolean;
  error: string | null;
  defaults: RoutineDefaults;
  onText: (text: string) => void;
  onPreview: () => void;
  onBack: () => void;
  onAdd: () => void;
  onOpen: (bot: DeyinBot) => void;
  onClose: () => void;
}

/** The import dialog as pure markup, so every step can be rendered without a host. */
export function BotImportView(props: BotImportViewProps) {
  const { state, busy, error } = props;
  const t = useT();
  const problem = pastedProblem(props.text);
  const blocked = state.step === "preview" ? importBlocked(state.summary.routines.length, props.defaults) : null;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (state.step === "paste") props.onPreview();
    else if (state.step === "preview") props.onAdd();
  };
  const line = state.step === "preview" ? comesWithLine(summaryCounts(state.summary)) : null;
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bot-import-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) props.onClose();
      }}
    >
      <form className="modal bot-import" onSubmit={submit}>
        <h2 id="bot-import-title" className="bot-create__title">
          {t("bot.share.importTitle")}
        </h2>
        {state.step === "paste" ? (
          <>
            <p className="hint">{t("bot.share.importHint")}</p>
            <div className="field">
              <label className="field__label" htmlFor="bot-import-text">
                {t("bot.share.pasteLabel")}
              </label>
              <textarea id="bot-import-text" className="input bot-panel__code" rows={8} value={props.text} disabled={busy} placeholder={t("bot.share.pastePlaceholder")} onChange={(event) => props.onText(event.target.value)} />
            </div>
          </>
        ) : null}
        {state.step === "preview" ? (
          <div className="bot-import__preview">
            <h3 className="bot-detail__heading">{state.summary.name}</h3>
            {state.summary.title ? <p className="bot-panel__meta">{state.summary.title}</p> : null}
            {state.summary.description ? <p>{state.summary.description}</p> : null}
            {line ? <p className="hint">{fill(t(line.key), line.vars)}</p> : null}
            {state.summary.skills.length > 0 ? (
              <ul className="bot-panel__list" aria-label={t("bot.skills.title")}>
                {state.summary.skills.map((skill) => (
                  <li key={skill.name} className="bot-panel__item">
                    <div className="bot-panel__main">
                      <strong className="bot-panel__name">{skill.name}</strong>
                      <span className="bot-panel__meta">{skill.description}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {state.summary.routines.length > 0 ? (
              <ul className="bot-panel__list" aria-label={t("bot.routines.title")}>
                {state.summary.routines.map((routine) => (
                  <li key={routine.name} className="bot-panel__item">
                    <div className="bot-panel__main">
                      <strong className="bot-panel__name">{routine.name}</strong>
                      <span className="bot-panel__meta">{t(routine.scheduled ? "bot.share.routineScheduled" : "bot.share.routineManual")}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="hint">{t("bot.share.safety")}</p>
            {blocked ? (
              <p className="hint--bad" role="status">
                {t(blocked)}
              </p>
            ) : null}
          </div>
        ) : null}
        {state.step === "done" ? (
          <div role="status">
            <p>
              {importedLines(state.result)
                .map((line) => fill(t(line.key), line.vars))
                .join(" ")}
            </p>
            {state.result.routines > 0 ? <p className="hint">{t("bot.share.routinesPaused")}</p> : null}
            {state.result.warnings.map((warning) => (
              <p key={warning} className="hint--bad">
                {warning}
              </p>
            ))}
          </div>
        ) : null}
        <p className="hint--bad" role="alert" hidden={!error}>
          {error}
        </p>
        <div className="modal__actions">
          {state.step === "done" ? (
            <>
              <button type="button" className="btn btn--ghost" onClick={props.onClose}>
                {t("bot.share.done")}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => props.onOpen(state.result.bot)}>
                {t("bot.share.openBot")}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={state.step === "preview" ? props.onBack : props.onClose}>
                {t(state.step === "preview" ? "bot.share.back" : "bot.create.cancel")}
              </button>
              <button type="submit" className="btn btn--primary" disabled={busy || (state.step === "paste" ? problem !== null : blocked !== null)}>
                {state.step === "paste" ? (busy ? t("bot.share.looking") : t("bot.share.look")) : busy ? t("bot.share.adding") : t("bot.share.add")}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

interface BotImportDialogProps {
  api: TemplatesApi;
  defaults: RoutineDefaults;
  /** A Bot's text or link to look at straight away, such as one a link opened the app with. */
  initialText?: string;
  onOpenBot: (bot: DeyinBot) => void;
  onClose: () => void;
}

/** Add a Bot someone shared: look at what it carries first, then say yes. */
export function BotImportDialog({ api, defaults, initialText, onOpenBot, onClose }: BotImportDialogProps) {
  const [text, setText] = useState(initialText ?? "");
  const [state, setState] = useState<ImportStep>({ step: "paste" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const preview = async (): Promise<void> => {
    if (busy || pastedProblem(text)) return;
    setBusy(true);
    setError(null);
    const outcome = await attempt(() => api.preview(text));
    if (!mounted.current) return;
    setBusy(false);
    if (outcome.ok) setState({ step: "preview", summary: outcome.value.summary });
    else setError(outcome.error);
  };

  // A Bot that arrived with the dialog (a link opened the app with it) is looked at without being asked.
  useEffect(() => {
    if (!initialText || !initialText.trim()) return;
    let current = true;
    setBusy(true);
    void attempt(() => api.preview(initialText)).then((outcome) => {
      if (!current || !mounted.current) return;
      setBusy(false);
      if (outcome.ok) setState({ step: "preview", summary: outcome.value.summary });
      else setError(outcome.error);
    });
    return () => {
      current = false;
    };
  }, [api, initialText]);

  const add = async (): Promise<void> => {
    if (busy || state.step !== "preview" || importBlocked(state.summary.routines.length, defaults)) return;
    setBusy(true);
    setError(null);
    const outcome = await attempt(() => api.import(text, { model: defaults.model, providerId: defaults.providerId }));
    if (!mounted.current) return;
    setBusy(false);
    if (outcome.ok) setState({ step: "done", result: outcome.value });
    else setError(outcome.error);
  };

  return (
    <BotImportView
      text={text}
      state={state}
      busy={busy}
      error={error}
      defaults={defaults}
      onText={(next) => {
        setError(null);
        setText(next);
      }}
      onPreview={() => void preview()}
      onBack={() => {
        setError(null);
        setState({ step: "paste" });
      }}
      onAdd={() => void add()}
      onOpen={onOpenBot}
      onClose={onClose}
    />
  );
}
