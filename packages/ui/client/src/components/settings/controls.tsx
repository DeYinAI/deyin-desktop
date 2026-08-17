import type { ReactNode } from "react";
import { Icon, type IconName } from "../Icon.js";

export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={`toggle ${checked ? "toggle--on" : ""}${disabled ? " toggle--disabled" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="toggle__thumb" />
    </button>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="settings-section">{children}</div>;
}

/** Two-per-row responsive grid of setting cards. */
export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="setting-grid">{children}</div>;
}

/** Segmented tab control used for in-page page groups (MCP/Plugins, Skills/...). */
export function TabBar<T extends string>(props: {
  tabs: { id: T; label: string; icon?: IconName }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabbar" role="tablist">
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === props.value}
          className={`tabbar__tab ${tab.id === props.value ? "tabbar__tab--active" : ""}`}
          onClick={() => props.onChange(tab.id)}
        >
          {tab.icon && <Icon name={tab.icon} size={13} />}
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}

/** One settings row: title + description on the left, a control on the right. */
export function SettingCard(props: { title: ReactNode; description?: string; children?: ReactNode }) {
  return (
    <div className="setting-card">
      <div className="setting-card__meta">
        <div className="setting-card__title">{props.title}</div>
        {props.description && <div className="setting-card__desc">{props.description}</div>}
      </div>
      <div className="setting-card__control">{props.children}</div>
    </div>
  );
}

export function PageHeader(props: { title: string; description?: string; children?: ReactNode }) {
  return (
    <>
      <div className="settings-page__header">
        <h1>{props.title}</h1>
        {props.children}
      </div>
      {props.description && <p className="settings-page__desc">{props.description}</p>}
    </>
  );
}
