import type { ReactNode } from "react";

/** Base HYRAX-style container: flat bordered card, small radius, no shadow. */
export function FlatCard(props: {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ui-flat-card${props.className ? ` ${props.className}` : ""}`}>
      {props.header && <div className="ui-flat-card__header">{props.header}</div>}
      <div className="ui-flat-card__body">{props.children}</div>
      {props.footer && <div className="ui-flat-card__footer">{props.footer}</div>}
    </div>
  );
}
