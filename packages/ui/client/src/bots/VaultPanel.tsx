import { VAULT_KINDS, type DeyinBot, type MessageKey, type VaultItem, type VaultKind, type VaultProtection, type VaultSnapshot } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { PageHeader, SettingCard, Toggle } from "../components/settings/controls.js";
import { VaultItemForm } from "./VaultItemForm.js";
import { cardExpired, cardExpiry, grantRows, groupItems, itemDetails, itemHeadline, type VaultForm } from "./botVault.js";

export type VaultState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; snapshot: VaultSnapshot };

const PROTECTION_TEXT: Record<VaultProtection, MessageKey> = {
  encrypted: "vault.protection.encrypted",
  "file-permissions": "vault.protection.file",
};

const ADD_LABEL: Record<VaultKind, MessageKey> = {
  login: "vault.add.login",
  card: "vault.add.card",
  contact: "vault.add.contact",
};

const GROUP_LABEL: Record<VaultKind, MessageKey> = {
  login: "vault.group.login",
  card: "vault.group.card",
  contact: "vault.group.contact",
};

export interface VaultPanelProps {
  state: VaultState;
  /** The roster, to name the Bots that may use an item. */
  bots: readonly Pick<DeyinBot, "id" | "name">[];
  /** The add or change form, while one is open. */
  editor: VaultForm | null;
  /** Something is being saved; the controls wait. */
  busy: boolean;
  error: string | null;
  /** Today, for telling an expired card. */
  now: Date;
  /** Whether Bots may sign in with logins kept in 1Password, and how to change it. Absent when the host has no such setting. */
  onePassword?: { enabled: boolean; onChange: (enabled: boolean) => void };
  onAdd: (kind: VaultKind) => void;
  onEdit: (item: VaultItem) => void;
  onRemove: (item: VaultItem) => void;
  onRevoke: (botId: string, itemId: string, host: string) => void;
  onForm: (patch: Partial<VaultForm>) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** The Vault: what is saved for Bots to fill into pages, which Bot may use what, and where it is kept. */
export function VaultPanel(props: VaultPanelProps) {
  const t = useT();
  const { state, editor, busy } = props;
  // The form shows its own refusal; this one is for a remove or a take-back.
  const pageError = editor ? null : props.error;
  return (
    <section className="vault" aria-label={t("vault.title")}>
      <PageHeader title={t("vault.title")} description={t("vault.hint")}>
        {VAULT_KINDS.map((kind) => (
          <button key={kind} type="button" className="btn btn--outline" disabled={busy || editor !== null || state.status !== "ready"} onClick={() => props.onAdd(kind)}>
            {t(ADD_LABEL[kind])}
          </button>
        ))}
      </PageHeader>

      {state.status === "loading" ? (
        <p className="hint" role="status">
          {t("vault.loading")}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="hint--bad" role="alert">
          {t("vault.loadError")} {state.error}
        </p>
      ) : null}
      {state.status === "ready" ? (
        <p className={`vault__protection vault__protection--${state.snapshot.protection}`} role="note">
          {t(PROTECTION_TEXT[state.snapshot.protection])}
        </p>
      ) : null}

      {props.onePassword ? (
        <SettingCard title={t("vault.onePassword.title")} description={t("vault.onePassword.hint")}>
          <Toggle checked={props.onePassword.enabled} label={t("vault.onePassword.label")} onChange={props.onePassword.onChange} />
        </SettingCard>
      ) : null}

      {editor ? <VaultItemForm form={editor} busy={busy} error={props.error} onForm={props.onForm} onSave={props.onSave} onCancel={props.onCancel} /> : null}

      {state.status === "ready" ? <Items {...props} snapshot={state.snapshot} /> : null}

      <p className="hint--bad" role="alert" hidden={!pageError}>
        {pageError}
      </p>
    </section>
  );
}

function Items({ snapshot, bots, now, busy, onEdit, onRemove, onRevoke }: VaultPanelProps & { snapshot: VaultSnapshot }) {
  const t = useT();
  const groups = groupItems(snapshot.items);
  if (groups.length === 0) return <p className="hint">{t("vault.empty")}</p>;
  return (
    <>
      {groups.map((group) => (
        <section key={group.kind} className="vault__group" aria-label={t(GROUP_LABEL[group.kind])}>
          <h3 className="bot-detail__subheading">{t(GROUP_LABEL[group.kind])}</h3>
          <ul className="vault__list">
            {group.items.map((item) => {
              const grants = grantRows(snapshot.grants, item.id, bots);
              return (
                <li key={item.id} className="vault-item">
                  <div className="vault-item__row">
                    <div className="vault-item__main">
                      <strong className="vault-item__title">{item.title}</strong>
                      <span className="vault-item__headline">{itemHeadline(item)}</span>
                      {itemDetails(item).map((line, index) => (
                        <span key={`${index}:${line}`} className="hint">
                          {line}
                        </span>
                      ))}
                      {item.kind === "card" && cardExpiry(item) !== "" ? (
                        <span className={cardExpired(item, now) ? "hint--bad" : "hint"}>{fill(t(cardExpired(item, now) ? "vault.card.expired" : "vault.card.expires"), { date: cardExpiry(item) })}</span>
                      ) : null}
                      {item.kind === "contact" && item.defaultShipping ? <span className="hint">{t("vault.defaultShipping")}</span> : null}
                      {item.notes ? <span className="hint">{item.notes}</span> : null}
                    </div>
                    <div className="vault-item__actions">
                      <button type="button" className="btn btn--ghost" disabled={busy} aria-label={`${t("vault.edit")}: ${item.title}`} onClick={() => onEdit(item)}>
                        {t("vault.edit")}
                      </button>
                      <button type="button" className="btn btn--ghost" disabled={busy} aria-label={`${t("vault.remove")}: ${item.title}`} onClick={() => onRemove(item)}>
                        {t("vault.remove")}
                      </button>
                    </div>
                  </div>
                  {grants.length > 0 ? (
                    <div className="vault-item__access">
                      <span className="field__label">{t("vault.access.title")}</span>
                      <ul className="vault__list">
                        {grants.map((grant) => {
                          const line = fill(t("vault.access.line"), { bot: grant.botName ?? t("vault.access.deletedBot"), site: grant.host });
                          return (
                            <li key={`${grant.botId}@${grant.host}`} className="bot-permission">
                              <span className="bot-permission__name">{line}</span>
                              <button type="button" className="btn btn--ghost" disabled={busy} aria-label={`${t("vault.access.revoke")}: ${line}`} onClick={() => onRevoke(grant.botId, item.id, grant.host)}>
                                {t("vault.access.revoke")}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
