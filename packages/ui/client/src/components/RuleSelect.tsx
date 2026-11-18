import { useState } from "react";
import { AnchoredMenu } from "./AnchoredMenu.js";
import { Icon } from "./Icon.js";

export interface RuleOption {
  id: string;
  label: string;
  /** Secondary line under the label (paths, short explanations). */
  hint?: string;
  disabled?: boolean;
}

interface RuleSelectProps {
  label: string;
  value: string;
  options: readonly RuleOption[];
  onChange: (id: string) => void;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  disabled?: boolean;
  /** Extra trailing entry, e.g. "Other folder…"; it never becomes the value. */
  action?: { label: string; onSelect: () => void };
}

/** One row of a settings card: label on the left, a menu-backed value on the right. */
export function RuleSelect(props: RuleSelectProps) {
  const [open, setOpen] = useState(false);
  const current = props.options.find((option) => option.id === props.value);
  return (
    <div className="rule-row">
      <span className="rule-row__label">{props.label}</span>
      {props.disabled ? (
        <span className="rule-value rule-value--disabled">
          <span className="rule-value__text">{current?.label ?? props.placeholder ?? ""}</span>
        </span>
      ) : (
        <AnchoredMenu
          open={open}
          onToggle={() => setOpen((v) => !v)}
          onClose={() => setOpen(false)}
          triggerClassName="rule-value"
          triggerTitle={props.label}
          panelClassName="rule-menu"
          trigger={
            <>
              <span className="rule-value__text">{current?.label ?? props.placeholder ?? ""}</span>
              <Icon name="chevronDown" size={12} className="rule-value__chev" />
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
                props.onChange(option.id);
              }}
            >
              <span className="rule-menu__text">
                <span className="rule-menu__label">{option.label}</span>
                {option.hint && <span className="rule-menu__hint">{option.hint}</span>}
              </span>
              {option.id === props.value && <Icon name="check" size={13} className="rule-menu__check" />}
            </button>
          ))}
          {props.action && (
            <>
              <div className="rule-menu__sep" />
              <button
                type="button"
                className="rule-menu__item"
                onClick={() => {
                  setOpen(false);
                  props.action?.onSelect();
                }}
              >
                <span className="rule-menu__text">
                  <span className="rule-menu__label">{props.action.label}</span>
                </span>
              </button>
            </>
          )}
        </AnchoredMenu>
      )}
    </div>
  );
}
