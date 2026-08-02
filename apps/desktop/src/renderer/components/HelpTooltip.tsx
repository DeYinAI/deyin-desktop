import type { ReactNode } from "react";

/** Inline help icon with hover tooltip for Reasonix settings. */
export function HelpTooltip(props: { text: string; children?: ReactNode }) {
  return (
    <span className="help-tooltip" title={props.text}>
      {props.children ?? (
        <span className="help-tooltip__icon" aria-label={props.text}>
          ?
        </span>
      )}
    </span>
  );
}
