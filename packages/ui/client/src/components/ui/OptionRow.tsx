import type { ReactNode } from "react";
import { Icon } from "../Icon.js";

/** Full-width selectable option row for question dialogs — no native radio chrome. */
export function OptionRow(props: {
  label: ReactNode;
  selected: boolean;
  onSelect: () => void;
  multi?: boolean;
  /** Extra content revealed inline when selected (e.g. "Other" text input). */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={props.className}>
      <button
        type="button"
        className={`ui-option-row${props.selected ? " ui-option-row--selected" : ""}`}
        aria-pressed={props.selected}
        onClick={props.onSelect}
      >
        <span className={`ui-option-row__marker${props.multi ? " ui-option-row__marker--multi" : ""}`}>
          {props.selected && (
            <span className="ui-option-row__mark">
              {!props.multi && <Icon name="check" size={9} />}
            </span>
          )}
        </span>
        <span>{props.label}</span>
      </button>
      {props.children && props.selected && <div style={{ marginTop: 6 }}>{props.children}</div>}
    </div>
  );
}
