import { useCallback, useState, type FormEvent } from "react";
import { SURFACE_SHAPES, type HubSettings, type SurfaceKind, type SurfaceView } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { writeClipboardText } from "../clipboard.js";
import {
  addressFor,
  addressLabelKey,
  allowHintKey,
  aboutKey,
  fieldHintKey,
  fieldLabelKey,
  isFieldName,
  isSurfaceFormDirty,
  kindLabelKey,
  missingText,
  noteKey,
  parseAllowText,
  statusKey,
  webhookExample,
  type RoutineChoice,
  type SurfaceForm,
  type SurfaceStatus,
} from "./botSurfaces.js";

/** A button that copies text and says so, and says nothing when the copy did not happen. */
export function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    const done = await writeClipboardText(text);
    setCopied(done);
    if (done) setTimeout(() => setCopied(false), 2000);
  }, [text]);
  return (
    <button type="button" className="btn btn--ghost" onClick={() => void copy()}>
      {copied ? t("bot.conn.copied") : t("bot.conn.copy")}
    </button>
  );
}

/** What a person can do about the routine a surface hands messages to. */
export type RoutineMaker = "ok" | "noModel" | "unavailable";

export interface SurfaceCardProps {
  kind: SurfaceKind;
  botId: string;
  view: SurfaceView | undefined;
  status: SurfaceStatus;
  hub: HubSettings;
  routines: readonly RoutineChoice[];
  /** The form while the card is open, or null while it is closed. */
  form: SurfaceForm | null;
  busy: boolean;
  error: string | null;
  saved: boolean;
  /** Keys this app made, shown once and never again. */
  generated: Readonly<Record<string, string>>;
  routineMaker: RoutineMaker;
  makingRoutine: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (patch: Partial<SurfaceForm>) => void;
  onSave: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  onRemake: (name: string) => void;
  onMakeRoutine: () => void;
  onDismissGenerated: (name: string) => void;
}

/** One way of reaching a Bot, as pure markup, so every state can be shown without a host. */
export function SurfaceCard(props: SurfaceCardProps) {
  const { kind, view, status, form } = props;
  const t = useT();
  const generatedNames = Object.keys(props.generated);
  return (
    <li className="conn-card" data-kind={kind} data-status={status}>
      <div className="conn-card__head">
        <div className="bot-panel__main">
          <strong className="bot-panel__name">{t(kindLabelKey(kind))}</strong>
          <span className="bot-panel__meta">{t(aboutKey(kind))}</span>
          {view && view.missing.length > 0 ? <span className="bot-panel__meta">{fill(t("bot.conn.needs"), { things: missingText(view.missing, t) })}</span> : null}
        </div>
        <div className="bot-panel__actions">
          <span className="conn-status" data-status={status}>
            {t(statusKey(status))}
          </span>
          {view ? (
            <button type="button" className="btn btn--ghost" disabled={props.busy || (!view.enabled && view.missing.length > 0)} onClick={() => props.onToggle(!view.enabled)}>
              {view.enabled ? t("bot.conn.turnOff") : t("bot.conn.turnOn")}
            </button>
          ) : null}
          <button type="button" className="btn btn--outline" aria-expanded={form !== null} onClick={form ? props.onClose : props.onOpen}>
            {form ? t("bot.conn.close") : view ? t("bot.conn.edit") : t("bot.conn.setUp")}
          </button>
        </div>
      </div>
      {generatedNames.map((name) => (
        <div key={name} className="conn-secret" role="status">
          <p className="hint">{fill(t("bot.conn.generated.title"), { name: isFieldName(name) ? t(fieldLabelKey(name)) : name })}</p>
          <code className="bot-panel__code conn-secret__value">{props.generated[name]}</code>
          <div className="bot-panel__buttons">
            <CopyButton text={props.generated[name] ?? ""} />
            <button type="button" className="btn btn--outline" onClick={() => props.onDismissGenerated(name)}>
              {t("bot.conn.generated.done")}
            </button>
          </div>
        </div>
      ))}
      {form ? <SurfaceFormView {...props} form={form} /> : null}
    </li>
  );
}

function SurfaceFormView(props: SurfaceCardProps & { form: SurfaceForm }) {
  const { kind, view, form } = props;
  const t = useT();
  const shape = SURFACE_SHAPES[kind];
  const idOf = (name: string): string => `conn-${props.botId}-${kind}-${name}`;
  const address = addressFor(props.hub, kind, props.botId);
  const addressLabel = addressLabelKey(kind);
  const allowHint = allowHintKey(kind);
  const dirty = isSurfaceFormDirty(kind, view, form);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    props.onSave();
  };
  return (
    <form className="bot-panel__editor" onSubmit={submit} aria-label={t(kindLabelKey(kind))}>
      <p className="hint">{t(noteKey(kind))}</p>

      {address && addressLabel ? (
        <div className="field">
          <label className="field__label" htmlFor={idOf("address")}>
            {t(addressLabel)}
          </label>
          <div className="conn-copy">
            <input id={idOf("address")} className="input bot-panel__code" value={address.url} readOnly />
            <CopyButton text={address.url} />
          </div>
          {address.local ? <span className="hint">{t("bot.conn.address.local")}</span> : null}
          {kind === "webhook" ? (
            <div className="conn-example">
              <span className="hint">{t("bot.conn.address.try")}</span>
              <code className="bot-panel__code">{webhookExample(address.url, props.generated.key ?? null)}</code>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor={idOf("routine")}>
          {t("bot.conn.routine")}
        </label>
        <select id={idOf("routine")} className="input" value={form.routineId} onChange={(event) => props.onChange({ routineId: event.target.value })}>
          <option value="">{t("bot.conn.routine.choose")}</option>
          {props.routines.map((routine) => (
            <option key={routine.id} value={routine.id}>
              {routine.scheduled ? fill(t("bot.conn.routine.scheduled"), { name: routine.name }) : routine.name}
            </option>
          ))}
        </select>
        {props.routines.length === 0 ? <span className="hint">{t("bot.conn.noRoutines")}</span> : null}
        {props.routineMaker === "ok" ? (
          <div>
            <button type="button" className="btn btn--ghost" disabled={props.makingRoutine} onClick={props.onMakeRoutine}>
              {props.makingRoutine ? t("bot.conn.routine.making") : t("bot.conn.routine.make")}
            </button>
          </div>
        ) : null}
        {props.routineMaker === "noModel" ? <span className="hint">{t("bot.conn.routine.noModel")}</span> : null}
      </div>

      {allowHint ? (
        <div className="field">
          <label className="field__label" htmlFor={idOf("allow")}>
            {t("bot.conn.allow")}
          </label>
          <textarea id={idOf("allow")} className="input bot-panel__code" rows={3} value={form.allow} spellCheck={false} autoComplete="off" aria-describedby={idOf("allow-hint")} onChange={(event) => props.onChange({ allow: event.target.value })} />
          <span id={idOf("allow-hint")} className="hint">
            {t(allowHint)}
          </span>
          {parseAllowText(form.allow).length === 0 ? <span className="hint--bad">{t("bot.conn.allow.empty")}</span> : null}
        </div>
      ) : null}

      {shape.settings.map((name) => (
        <div className="field" key={name}>
          <label className="field__label" htmlFor={idOf(name)}>
            {isFieldName(name) ? t(fieldLabelKey(name)) : name}
          </label>
          <input
            id={idOf(name)}
            className="input"
            value={form.settings[name] ?? ""}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={idOf(`${name}-hint`)}
            onChange={(event) => props.onChange({ settings: { ...form.settings, [name]: event.target.value } })}
          />
          <FieldHint id={idOf(`${name}-hint`)} name={name} />
        </div>
      ))}

      {shape.secrets.map((name) => (
        <div className="field" key={name}>
          <label className="field__label" htmlFor={idOf(name)}>
            {isFieldName(name) ? t(fieldLabelKey(name)) : name}
          </label>
          <input
            id={idOf(name)}
            className="input"
            type="password"
            value={form.secrets[name] ?? ""}
            autoComplete="off"
            spellCheck={false}
            placeholder={view?.has[name] ? t("bot.conn.secret.saved") : t("bot.conn.secret.fresh")}
            aria-describedby={idOf(`${name}-hint`)}
            onChange={(event) => props.onChange({ secrets: { ...form.secrets, [name]: event.target.value } })}
          />
          <FieldHint id={idOf(`${name}-hint`)} name={name} />
        </div>
      ))}

      {shape.generated.map((name) => {
        const label = isFieldName(name) ? t(fieldLabelKey(name)) : name;
        return view?.has[name] ? (
          <div className="field" key={name}>
            <span className="field__label">{fill(t("bot.conn.generated.isSet"), { name: label })}</span>
            <div>
              <button type="button" className="btn btn--ghost" disabled={props.busy} onClick={() => props.onRemake(name)}>
                {fill(t("bot.conn.generated.make"), { name: label })}
              </button>
            </div>
          </div>
        ) : null;
      })}

      <p className="hint--bad" role="alert" hidden={!props.error}>
        {props.error}
      </p>
      <div className="bot-panel__buttons">
        <span className="hint" role="status">
          {props.saved && !dirty ? t("bot.conn.saved") : ""}
        </span>
        {view ? (
          <button type="button" className="btn btn--ghost btn--danger" disabled={props.busy} onClick={props.onRemove}>
            {t("bot.conn.remove")}
          </button>
        ) : null}
        <button type="submit" className="btn btn--primary" disabled={props.busy || !dirty}>
          {props.busy ? t("bot.conn.saving") : t("bot.conn.save")}
        </button>
      </div>
    </form>
  );
}

function FieldHint({ id, name }: { id: string; name: string }) {
  const t = useT();
  const key = isFieldName(name) ? fieldHintKey(name) : null;
  return key ? (
    <span id={id} className="hint">
      {t(key)}
    </span>
  ) : null;
}
