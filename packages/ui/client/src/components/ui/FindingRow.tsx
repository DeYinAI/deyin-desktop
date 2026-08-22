import type { ReactNode } from "react";

/** Dot separator used inside meta lines. */
function Sep() {
  return <span style={{ margin: "0 4px", opacity: 0.6 }}>·</span>;
}

/** HYRAX finding-list row: severity badge · title · tags/meta line · body · actions. */
export function FindingRow(props: {
  severity?: "critical" | "high" | "medium" | "low" | "info";
  title: ReactNode;
  /** Inline code-ish chips shown next to the title (e.g. scanner source). */
  tags?: ReactNode;
  /** Monospace metadata fragments joined by dots. */
  meta?: ReactNode[];
  /** Optional message/body text under the title line. */
  body?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  const clickable = Boolean(props.onClick);
  const hasMeta = Boolean(props.meta?.length) || Boolean(props.tags);
  return (
    <div
      className={`ui-finding-row${clickable ? " ui-finding-row--clickable" : ""}${props.className ? ` ${props.className}` : ""}`}
      onClick={props.onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
      {props.severity && (
        <span className={`ui-sev ui-sev--${props.severity}`}>{props.severity}</span>
      )}
      <div className="ui-finding-row__main">
        <div className="ui-finding-row__title-line">
          <span className="ui-finding-row__title">{props.title}</span>
          {props.tags}
          {props.status && <span className="ui-finding-row__status">{props.status}</span>}
        </div>
        {hasMeta && (
          <div className="ui-meta-row">
            {props.meta?.map((item, i) => (
              <span key={i} className="ui-meta-row__item">
                {item}
                {i < (props.meta?.length ?? 0) - 1 && <Sep />}
              </span>
            ))}
          </div>
        )}
        {(props.body || props.children) && (
          <div className="ui-finding-row__body">{props.body ?? props.children}</div>
        )}
      </div>
      {props.actions && <div className="ui-finding-row__actions">{props.actions}</div>}
    </div>
  );
}
