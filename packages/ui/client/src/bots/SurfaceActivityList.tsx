import { useT } from "../i18n.js";
import { kindLabelKey, type ActivityRow } from "./botSurfaces.js";

/** What lately happened at the Bot's connections, so a message that was turned away can be explained. */
export function SurfaceActivityList({ rows }: { rows: readonly ActivityRow[] }) {
  const t = useT();
  return (
    <section className="conn-section" aria-label={t("bot.activity.title")}>
      <h4 className="conn-section__title">{t("bot.activity.title")}</h4>
      {rows.length === 0 ? (
        <p className="hint">{t("bot.activity.empty")}</p>
      ) : (
        <ul className="conn-activity">
          {rows.map((row) => (
            <li key={row.key} className="conn-activity__row" data-tone={row.tone}>
              <time className="bot-panel__meta" dateTime={new Date(row.at).toISOString()}>
                {new Date(row.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
              <span className="bot-panel__badge">{t(kindLabelKey(row.surface))}</span>
              <span>{t(row.label)}</span>
              {row.count > 1 ? <span className="bot-panel__badge">{`×${row.count}`}</span> : null}
              {row.detail ? <span className="bot-panel__meta">{row.detail}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
