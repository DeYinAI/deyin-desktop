import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { BotInput, BotResult, DeyinBot } from "@deyin/contract";
import { BOT_LIMITS } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { BotAvatar } from "../components/BotAvatar.js";
import { BotAvatarPicker } from "./BotAvatarPicker.js";
import { formProblem, formToInput, newBotForm, submitBotForm, type BotForm } from "./botForm.js";

interface BotCreateDialogProps {
  /** Creates the Bot; the dialog closes only when this resolves with success. */
  onCreate: (input: BotInput) => Promise<BotResult<DeyinBot>>;
  onCreated: (bot: DeyinBot) => void;
  onCancel: () => void;
  /** Seeds the starting avatar. Injected so a test can pin it; the app passes a fresh random seed. */
  seed?: string;
  /** The Bot is being made as the person's primary Bot: the dialog says so. */
  primary?: boolean;
}

/** The "New Bot" dialog: a name, a label, and an avatar. Everything else is edited later on the Bot's page. */
export function BotCreateDialog({ onCreate, onCreated, onCancel, seed, primary = false }: BotCreateDialogProps) {
  const t = useT();
  const initialSeed = useMemo(() => seed ?? `new-${Math.random().toString(36).slice(2)}`, [seed]);
  const [form, setForm] = useState<BotForm>(() => newBotForm(initialSeed));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const problem = formProblem(form, "create");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    const outcome = await submitBotForm(() => onCreate(formToInput(form)));
    setBusy(false);
    if (outcome.kind === "done") onCreated(outcome.value);
    else setError(outcome.error);
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bot-create-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form className="modal bot-create" onSubmit={submit}>
        <h2 id="bot-create-title" className="bot-create__title">
          {t(primary ? "bot.primary.createTitle" : "bot.create.title")}
        </h2>
        <div className="bot-create__preview">
          <BotAvatar bot={{ name: form.name || t("bot.create.namePlaceholder"), avatarShape: form.avatarShape, avatarColor: form.avatarColor }} size={72} decorative />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="bot-create-name">
            {t("bot.create.name")}
          </label>
          <input
            id="bot-create-name"
            ref={nameRef}
            className="input"
            value={form.name}
            placeholder={t("bot.create.namePlaceholder")}
            disabled={busy}
            maxLength={BOT_LIMITS.name}
            autoComplete="off"
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="bot-create-label">
            {t("bot.create.label")}
          </label>
          <input
            id="bot-create-label"
            className="input"
            value={form.title}
            placeholder={t("bot.create.labelPlaceholder")}
            disabled={busy}
            maxLength={BOT_LIMITS.title}
            autoComplete="off"
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
        </div>
        <div className="field">
          <span className="field__label">{t("bot.create.avatar")}</span>
          <BotAvatarPicker
            shape={form.avatarShape}
            color={form.avatarColor}
            name={form.name}
            disabled={busy}
            onChange={({ shape, color }) => setForm({ ...form, avatarShape: shape, avatarColor: color })}
          />
        </div>
        <p className="bot-create__error hint--bad" role="alert" hidden={!error}>
          {error}
        </p>
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onCancel}>
            {t("bot.create.cancel")}
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || problem !== null}>
            {busy ? t("bot.create.creating") : t("bot.create.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
