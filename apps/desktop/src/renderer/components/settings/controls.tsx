import type { ReactNode } from "react";

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`toggle ${checked ? "toggle--on" : ""}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__thumb" />
    </button>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="settings-section">{children}</div>;
}

/** One settings row: title + description on the left, a control on the right. */
export function SettingCard(props: { title: string; description?: string; children?: ReactNode }) {
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
