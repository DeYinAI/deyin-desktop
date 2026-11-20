import { SURFACE_LIMITS } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { fill } from "../automationFormat.js";
import { safeLink, type OutboxRow } from "./botSurfaces.js";

export interface SurfaceOutboxProps {
  waiting: readonly OutboxRow[];
  earlier: readonly OutboxRow[];
  /** The post being sent now, so its buttons wait. */
  busyId: string | null;
  /** Why a call about a post was refused, by post id. */
  errors: Readonly<Record<string, string>>;
  onEdit: (id: string, text: string) => void;
  onApprove: (row: OutboxRow) => void;
  onDeny: (id: string) => void;
}

/** Posts the Bot wants to make on X. Nothing here is sent until a person approves the words they see. */
export function SurfaceOutbox(props: SurfaceOutboxProps) {
  const t = useT();
  return (
    <section className="conn-section" aria-label={t("bot.outbox.title")}>
      <h4 className="conn-section__title">{t("bot.outbox.title")}</h4>
      <p className="hint">{t("bot.outbox.hint")}</p>
      {props.waiting.length === 0 ? <p className="hint">{t("bot.outbox.empty")}</p> : null}
      {props.waiting.length > 0 ? (
        <ul className="bot-panel__list">
          {props.waiting.map((row) => (
            <WaitingPost key={row.post.id} row={row} busy={props.busyId === row.post.id} error={props.errors[row.post.id] ?? null} onEdit={props.onEdit} onApprove={props.onApprove} onDeny={props.onDeny} />
          ))}
        </ul>
      ) : null}
      {props.earlier.length > 0 ? (
        <>
          <h5 className="conn-section__sub">{t("bot.outbox.earlier")}</h5>
          <ul className="bot-panel__list">
            {props.earlier.map((row) => (
              <DecidedPost key={row.post.id} row={row} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function PostContext({ row }: { row: OutboxRow }) {
  const t = useT();
  return (
    <>
      <span className="bot-panel__meta">{fill(t("bot.outbox.replyingTo"), { author: row.post.author })}</span>
      <blockquote className="conn-post__context">{fill(t("bot.outbox.theySaid"), { text: row.post.context })}</blockquote>
    </>
  );
}

function WaitingPost({ row, busy, error, onEdit, onApprove, onDeny }: { row: OutboxRow; busy: boolean; error: string | null } & Pick<SurfaceOutboxProps, "onEdit" | "onApprove" | "onDeny">) {
  const t = useT();
  const id = `conn-post-${row.post.id}`;
  const sending = busy || !row.open;
  return (
    <li className="conn-post">
      <PostContext row={row} />
      <label className="field__label" htmlFor={id}>
        {t("bot.outbox.reply")}
      </label>
      <textarea id={id} className="input" rows={3} value={row.text} readOnly={sending} aria-describedby={`${id}-count`} onChange={(event) => onEdit(row.post.id, event.target.value)} />
      <span id={`${id}-count`} className={row.over > 0 ? "hint--bad" : "hint"}>
        {fill(t("bot.outbox.count"), { used: row.used, max: SURFACE_LIMITS.xChars })}
        {row.over > 0 ? ` ${fill(t("bot.outbox.over"), { over: row.over })}` : ""}
      </span>
      <p className="hint--bad" role="alert" hidden={!error}>
        {error}
      </p>
      <div className="bot-panel__buttons">
        <button type="button" className="btn btn--ghost" disabled={sending} onClick={() => onDeny(row.post.id)}>
          {t("bot.outbox.deny")}
        </button>
        <button type="button" className="btn btn--primary" disabled={sending || row.problem !== null} onClick={() => onApprove(row)}>
          {sending ? t("bot.outbox.posting") : t("bot.outbox.approve")}
        </button>
      </div>
    </li>
  );
}

function DecidedPost({ row }: { row: OutboxRow }) {
  const t = useT();
  const link = safeLink(row.post.url);
  return (
    <li className="conn-post" data-status={row.post.status}>
      <PostContext row={row} />
      <p className="conn-post__text">{row.post.text}</p>
      <div className="bot-panel__actions">
        <span className="bot-panel__badge">{t(row.status)}</span>
        {link ? (
          <a href={link} target="_blank" rel="noreferrer noopener">
            {t("bot.outbox.view")}
          </a>
        ) : null}
      </div>
      {row.post.error ? <span className="hint--bad">{row.post.error}</span> : null}
    </li>
  );
}
