import { useId, type FormEvent } from "react";
import type { HubSettings, HubStatus } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { hubProblem, isHubFormDirty, type HubForm } from "./botSurfaces.js";

export interface SurfaceHubProps {
  settings: HubSettings;
  status: HubStatus;
  form: HubForm;
  busy: boolean;
  /** A refusal from the host, shown beside the problem found while typing. */
  error: string | null;
  saved: boolean;
  onChange: (patch: Partial<HubForm>) => void;
  onSave: () => void;
  onRetry: () => void;
}

/** Where this computer listens for the services that call a Bot, and the public address shown for it. */
export function SurfaceHub(props: SurfaceHubProps) {
  const t = useT();
  const id = useId();
  const dirty = isHubFormDirty(props.settings, props.form);
  const problem = dirty ? hubProblem(props.form) : null;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (dirty && !problem) props.onSave();
  };
  return (
    <section className="conn-section" aria-label={t("bot.conn.hub.title")}>
      <h4 className="conn-section__title">{t("bot.conn.hub.title")}</h4>
      {props.status.listening ? (
        <p className="hint" role="status">
          {fill(t("bot.conn.hub.listening"), { port: props.status.port })}
        </p>
      ) : props.status.error ? (
        <div className="conn-blocked" role="alert">
          <p className="hint--bad">{fill(t("bot.conn.hub.blocked"), { port: props.status.port, error: props.status.error })}</p>
          <button type="button" className="btn btn--outline" disabled={props.busy} onClick={props.onRetry}>
            {t("bot.conn.hub.retry")}
          </button>
        </div>
      ) : (
        <p className="hint" role="status">
          {t("bot.conn.hub.idle")}
        </p>
      )}
      <form className="bot-panel__editor" onSubmit={submit}>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-port`}>
            {t("bot.conn.hub.port")}
          </label>
          <input id={`${id}-port`} className="input" inputMode="numeric" value={props.form.port} autoComplete="off" onChange={(event) => props.onChange({ port: event.target.value })} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-public`}>
            {t("bot.conn.hub.public")}
          </label>
          <input
            id={`${id}-public`}
            className="input"
            type="url"
            value={props.form.publicUrl}
            placeholder={t("bot.conn.hub.publicPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-public-hint`}
            onChange={(event) => props.onChange({ publicUrl: event.target.value })}
          />
          <span id={`${id}-public-hint`} className="hint">
            {t("bot.conn.hub.publicHint")}
          </span>
        </div>
        <p className="hint--bad" role="alert" hidden={!props.error && !problem}>
          {props.error ?? problem}
        </p>
        <div className="bot-panel__buttons">
          <span className="hint" role="status">
            {props.saved && !dirty ? t("bot.conn.hub.saved") : ""}
          </span>
          <button type="submit" className="btn btn--primary" disabled={props.busy || !dirty || problem !== null}>
            {props.busy ? t("bot.conn.hub.saving") : t("bot.conn.hub.save")}
          </button>
        </div>
      </form>
    </section>
  );
}
