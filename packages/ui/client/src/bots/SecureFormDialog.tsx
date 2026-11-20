import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { SecureFormRequest } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { Icon } from "../components/Icon.js";
import { canSubmitSecureForm, emptySecureFormValues, secureFormAnswer, type SecureFormValues } from "./secureForm.js";

interface SecureFormDialogProps {
  request: SecureFormRequest;
  /** What was typed, only for the fields that were filled. */
  onSubmit: (values: SecureFormValues) => void;
  onCancel: () => void;
}

/**
 * A Bot asks for something it was not given: a one-time code, a password for a site the Vault does not hold.
 * What is typed goes to the page and nowhere else, so this keeps it in this card only, until it is sent.
 */
export function SecureFormDialog({ request, onSubmit, onCancel }: SecureFormDialogProps) {
  const t = useT();
  const [values, setValues] = useState<SecureFormValues>(() => emptySecureFormValues(request));
  const ready = canSubmitSecureForm(request, values);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const answer = secureFormAnswer(request, values);
    if (answer) onSubmit(answer);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <form className="inline-card secure-form" aria-label={request.title} onSubmit={submit} onKeyDown={onKeyDown}>
      <Icon name="lock" size={16} className="inline-card__icon" />
      <div className="inline-card__text">
        <div className="secure-form__kicker">{t("bot.secureForm.heading")}</div>
        <div className="inline-card__title">{request.title}</div>
        {request.reason ? <div className="inline-card__body">{request.reason}</div> : null}
        <div className="inline-card__body">{fill(t("bot.secureForm.intro"), { host: request.host })}</div>
        <div className="secure-form__fields">
          {request.fields.map((field, index) => (
            <div key={field.id} className="field">
              <label className="field__label" htmlFor={`secure-form-${field.id}`}>
                {field.label}
              </label>
              <input
                id={`secure-form-${field.id}`}
                className="input"
                type={field.secret ? "password" : "text"}
                value={values[field.id] ?? ""}
                autoComplete={field.secret ? "new-password" : "off"}
                spellCheck={false}
                autoFocus={index === 0}
                onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="inline-card__actions">
        <button type="button" className="btn btn--pill btn--ghost" onClick={onCancel}>
          {t("bot.secureForm.cancel")}
        </button>
        <button type="submit" className="btn btn--pill btn--solid" disabled={!ready}>
          {t("bot.secureForm.fill")}
        </button>
      </div>
    </form>
  );
}
