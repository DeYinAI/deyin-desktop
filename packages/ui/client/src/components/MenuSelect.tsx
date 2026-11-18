import { useState } from "react";
import type { AnchorAlign } from "../hooks/useAnchoredMenuPosition.js";
import { AnchoredMenu } from "./AnchoredMenu.js";
import { Icon } from "./Icon.js";

export interface MenuSelectOption<T extends string = string> {
  id: T;
  label: string;
  /** A second line under the label: what the choice does, or why it cannot be picked. */
  hint?: string;
  disabled?: boolean;
}

interface MenuSelectProps<T extends string> {
  /** What the control is for ("Superagent state"). It names the control for assistive tech and in its tooltip. */
  label: string;
  value: T;
  options: readonly MenuSelectOption<T>[];
  onChange: (id: T) => void;
  disabled?: boolean;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  /** Which edge of the control the menu lines up with. */
  align?: AnchorAlign;
  /** Fill the width of the container, as a table cell does. */
  block?: boolean;
  className?: string;
}

/**
 * A dropdown made of the app's own menu, in place of a native `<select>`: the open list of a native select is drawn by the
 * operating system and ignores the theme. It takes the same fill and size as `.select`, and picking an option that is already
 * selected changes nothing, as with a native select.
 */
export function MenuSelect<T extends string>(props: MenuSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const current = props.options.find((option) => option.id === props.value);
  const text = current?.label ?? props.placeholder ?? "";
  return (
    <AnchoredMenu
      open={open && !props.disabled}
      onToggle={() => setOpen((value) => !value)}
      onClose={() => setOpen(false)}
      className={props.className}
      align={props.align}
      triggerClassName={`menu-select${props.block ? " menu-select--block" : ""}`}
      triggerTitle={props.label}
      triggerAriaLabel={text ? `${props.label}: ${text}` : props.label}
      triggerDisabled={props.disabled}
      panelClassName="rule-menu menu-select__panel"
      trigger={
        <>
          <span className="menu-select__text">{text}</span>
          <Icon name="chevronDown" size={12} className="menu-select__chev" />
        </>
      }
    >
      {props.options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="menuitemradio"
          aria-checked={option.id === props.value}
          disabled={option.disabled}
          className="rule-menu__item"
          onClick={() => {
            setOpen(false);
            if (option.id !== props.value) props.onChange(option.id);
          }}
        >
          <span className="rule-menu__text">
            <span className="rule-menu__label">{option.label}</span>
            {option.hint && <span className="rule-menu__hint">{option.hint}</span>}
          </span>
          {option.id === props.value && <Icon name="check" size={13} className="rule-menu__check" />}
        </button>
      ))}
    </AnchoredMenu>
  );
}
