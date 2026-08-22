import type { ReactNode } from "react";

/** Uppercase letter-spaced section header ("PIPELINE", "BOUNDARIES") with
 * optional right-aligned mono trailing text. */
export function SectionLabel(props: { children: ReactNode; trailing?: ReactNode; className?: string }) {
  return (
    <div className={`ui-section-label${props.className ? ` ${props.className}` : ""}`}>
      <span className="ui-section-label__text">{props.children}</span>
      {props.trailing && <span className="ui-section-label__trailing">{props.trailing}</span>}
    </div>
  );
}
