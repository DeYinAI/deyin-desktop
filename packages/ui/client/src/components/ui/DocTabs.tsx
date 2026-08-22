import type { ReactNode } from "react";
import { Icon } from "../Icon.js";

export interface DocTab {
  id: string;
  label: string;
  icon?: string;
  /** Small status dot (e.g. pending diff). */
  dot?: boolean;
  closable?: boolean;
}

/** HYRAX-style document tab bar: icon + doc-name labels. */
export function DocTabs(props: {
  tabs: DocTab[];
  active: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  leading?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ui-doc-tabs${props.className ? ` ${props.className}` : ""}`}>
      {props.leading && <div style={{ marginRight: 8 }}>{props.leading}</div>}
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`ui-doc-tab${tab.id === props.active ? " ui-doc-tab--active" : ""}`}
          onClick={() => props.onSelect(tab.id)}
        >
          {tab.icon && (
            <span className="ui-doc-tab__icon">
              <Icon name={tab.icon} size={12} />
            </span>
          )}
          <span className="ui-doc-tab__label">{tab.label}</span>
          {tab.dot && <span className="ui-doc-tab__dot" />}
          {tab.closable && props.onClose && (
            <span
              className="ui-doc-tab__close"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                props.onClose?.(tab.id);
              }}
            >
              <Icon name="close" size={10} />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
