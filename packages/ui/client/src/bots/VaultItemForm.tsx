import type { FormEvent } from "react";
import type { MessageKey, VaultKind } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { FORM_LIMITS, vaultFormProblem, type AddressForm, type VaultForm } from "./botVault.js";

interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  maxLength?: number;
  /** A box for one entry per line instead of a single line. */
  lines?: boolean;
  /** Masks what is typed, for a secret a person might be watched typing. */
  secret?: boolean;
  numeric?: boolean;
  placeholder?: string;
}

function TextField({ id, label, value, onChange, hint, maxLength, lines, secret, numeric, placeholder }: TextFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {lines ? (
        <textarea
          id={id}
          className="input vault-form__lines"
          rows={3}
          value={value}
          aria-describedby={hintId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          className="input"
          type={secret ? "password" : "text"}
          inputMode={numeric ? "numeric" : undefined}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-describedby={hintId}
          autoComplete={secret ? "new-password" : "off"}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint ? (
        <span id={hintId} className="hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

const ADDRESS_PARTS: ReadonlyArray<{ part: keyof AddressForm; label: MessageKey }> = [
  { part: "name", label: "vault.address.name" },
  { part: "line1", label: "vault.address.line1" },
  { part: "line2", label: "vault.address.line2" },
  { part: "city", label: "vault.address.city" },
  { part: "region", label: "vault.address.region" },
  { part: "postalCode", label: "vault.address.postalCode" },
  { part: "country", label: "vault.address.country" },
  { part: "phone", label: "vault.address.phone" },
];

function AddressFields({ prefix, legend, value, onChange }: { prefix: string; legend: string; value: AddressForm; onChange: (next: AddressForm) => void }) {
  const t = useT();
  return (
    <fieldset className="vault-form__address">
      <legend className="field__label">{legend}</legend>
      {ADDRESS_PARTS.map(({ part, label }) => (
        <TextField key={part} id={`${prefix}-${part}`} label={t(label)} value={value[part]} maxLength={FORM_LIMITS.line} onChange={(text) => onChange({ ...value, [part]: text })} />
      ))}
    </fieldset>
  );
}

const ADD_TITLE: Record<VaultKind, MessageKey> = {
  login: "vault.form.addLogin",
  card: "vault.form.addCard",
  contact: "vault.form.addContact",
};

export interface VaultItemFormProps {
  form: VaultForm;
  busy: boolean;
  error: string | null;
  onForm: (patch: Partial<VaultForm>) => void;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * Adds or changes one Vault item. The secrets (password, card number, security code) are typed here and sent
 * to the host once; when changing an item they start empty, because the host never sends them back, and
 * leaving one empty keeps what is saved.
 */
export function VaultItemForm({ form, busy, error, onForm, onSave, onCancel }: VaultItemFormProps) {
  const t = useT();
  const editing = form.id !== "";
  const problem = vaultFormProblem(form);
  const heading = editing ? fill(t("vault.form.edit"), { title: form.title }) : t(ADD_TITLE[form.kind]);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!busy && problem === null) onSave();
  };
  /** What to say under a secret box: that a saved one stays unless replaced, or that it is never shown again. */
  const secretHint = (saved: boolean, template: MessageKey = "vault.secret.keep"): string =>
    saved ? fill(t(template), { last4: form.saved.last4 }) : t("vault.secret.writeOnly");

  return (
    <form className="vault-form" onSubmit={submit} aria-label={heading}>
      <h3 className="bot-detail__heading">{heading}</h3>
      <fieldset className="vault-form__body" disabled={busy}>
        <TextField id="vault-title" label={t("vault.field.title")} value={form.title} maxLength={FORM_LIMITS.title} onChange={(title) => onForm({ title })} />

        {form.kind === "login" ? (
          <>
            <TextField id="vault-username" label={t("vault.field.username")} value={form.username} maxLength={FORM_LIMITS.username} onChange={(username) => onForm({ username })} />
            <TextField
              id="vault-password"
              label={t("vault.field.password")}
              value={form.password}
              maxLength={FORM_LIMITS.password}
              secret
              hint={secretHint(form.saved.password)}
              onChange={(password) => onForm({ password })}
            />
            <TextField id="vault-sites" label={t("vault.field.sites")} value={form.sites} lines hint={t("vault.field.sitesHint")} onChange={(sites) => onForm({ sites })} />
          </>
        ) : null}

        {form.kind === "card" ? (
          <>
            <TextField
              id="vault-number"
              label={t("vault.field.number")}
              value={form.number}
              maxLength={23}
              numeric
              hint={secretHint(editing && form.saved.last4 !== "", "vault.secret.keepEnding")}
              onChange={(number) => onForm({ number })}
            />
            <TextField
              id="vault-security-code"
              label={t("vault.field.securityCode")}
              value={form.securityCode}
              maxLength={4}
              numeric
              secret
              hint={secretHint(form.saved.securityCode)}
              onChange={(securityCode) => onForm({ securityCode })}
            />
            <div className="vault-form__pair">
              <TextField id="vault-exp-month" label={t("vault.field.expMonth")} value={form.expMonth} maxLength={2} numeric onChange={(expMonth) => onForm({ expMonth })} />
              <TextField id="vault-exp-year" label={t("vault.field.expYear")} value={form.expYear} maxLength={4} numeric onChange={(expYear) => onForm({ expYear })} />
            </div>
            <TextField id="vault-holder" label={t("vault.field.holderName")} value={form.holderName} maxLength={FORM_LIMITS.line} onChange={(holderName) => onForm({ holderName })} />
            <AddressFields prefix="vault-billing" legend={t("vault.field.billing")} value={form.billing} onChange={(billing) => onForm({ billing })} />
          </>
        ) : null}

        {form.kind === "contact" ? (
          <>
            <TextField id="vault-email" label={t("vault.field.email")} value={form.email} maxLength={FORM_LIMITS.email} onChange={(email) => onForm({ email })} />
            <TextField id="vault-emails" label={t("vault.field.emails")} value={form.emails} lines hint={t("vault.field.listHint")} onChange={(emails) => onForm({ emails })} />
            <TextField id="vault-phones" label={t("vault.field.phones")} value={form.phones} lines hint={t("vault.field.listHint")} onChange={(phones) => onForm({ phones })} />
            <AddressFields prefix="vault-address" legend={t("vault.field.address")} value={form.address} onChange={(address) => onForm({ address })} />
            <label className="vault-form__check">
              <input type="checkbox" checked={form.defaultShipping} onChange={(event) => onForm({ defaultShipping: event.target.checked })} />
              <span>{t("vault.field.defaultShipping")}</span>
            </label>
          </>
        ) : null}

        <TextField id="vault-notes" label={t("vault.field.notes")} value={form.notes} maxLength={FORM_LIMITS.notes} onChange={(notes) => onForm({ notes })} />
      </fieldset>

      {problem ? <p className="hint">{t(problem)}</p> : null}
      <p className="hint--bad" role="alert" hidden={!error}>
        {error}
      </p>
      <div className="vault-form__buttons">
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={onCancel}>
          {t("vault.cancel")}
        </button>
        <button type="submit" className="btn btn--outline" disabled={busy || problem !== null}>
          {busy ? t("vault.saving") : t("vault.save")}
        </button>
      </div>
    </form>
  );
}
