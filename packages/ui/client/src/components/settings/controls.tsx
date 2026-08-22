import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../Icon.js";
import { BrandMark, markFor } from "../BrandMark.js";

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

/**
 * Section heading above a list: label, an optional muted count, an optional
 * right-hand note or actions. A hairline under it separates it from the rows.
 */
export function SectionHeader(props: {
  title: ReactNode;
  count?: number | string;
  note?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="section-head">
      <span className="section-head__title">{props.title}</span>
      {props.count !== undefined && (
        <span className="section-head__count">
          {props.count} {props.count === 1 ? "item" : "items"}
        </span>
      )}
      {(props.note || props.actions) && (
        <span className="section-head__aside">
          {props.note && <span className="section-head__note">{props.note}</span>}
          {props.actions}
        </span>
      )}
    </div>
  );
}

/** One card holding a column of hairline-separated setting rows. */
export function SettingGroup({ children }: { children: ReactNode }) {
  return <div className="setting-group">{children}</div>;
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

/** Pill segmented control for scope filters (Public / Personal, ranges). */
export function Segmented<T extends string>(props: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className={`segmented${props.size === "sm" ? " segmented--sm" : ""}`} role="tablist">
      {props.options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={option.id === props.value}
          className={`segmented__item${option.id === props.value ? " segmented__item--active" : ""}`}
          onClick={() => props.onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Underlined tabs for page-level views (App usage / Plan). */
export function UnderlineTabs<T extends string>(props: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="utabs" role="tablist">
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === props.value}
          className={`utabs__tab${tab.id === props.value ? " utabs__tab--active" : ""}`}
          onClick={() => props.onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** One settings row: title + description on the left, a control on the right. */
export function SettingCard(props: { title: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="setting-card">
      <div className="setting-card__meta">
        <div className="setting-card__title">{props.title}</div>
        {props.description && <div className="setting-card__desc">{props.description}</div>}
      </div>
      {props.children && <div className="setting-card__control">{props.children}</div>}
    </div>
  );
}

/**
 * Stacked form field: label (+ hint) above a full-width control. Used where the
 * control is a text input, textarea or long select — `SettingCard`'s left/right
 * split squeezes those into a sliver at the far right of a wide page.
 */
export function Field(props: {
  label: ReactNode;
  hint?: ReactNode;
  /** Rendered under the control in the danger color; also marks the field invalid. */
  error?: ReactNode;
  /** Trailing controls shown on the label row (Browse…, Test, Import file…). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`field${props.error ? " field--error" : ""}`}>
      <div className="field__head">
        <span className="field__label">{props.label}</span>
        {props.action && <span className="field__action">{props.action}</span>}
      </div>
      {props.hint && <div className="field__hint">{props.hint}</div>}
      <div className="field__control">{props.children}</div>
      {props.error && <div className="field__error">{props.error}</div>}
    </div>
  );
}

/** Card wrapping a titled block of `Field`s / rows. */
export function FormSection(props: { title: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="form-section">
      <div className="form-section__head">
        <span className="form-section__title">{props.title}</span>
        {props.note && <span className="form-section__note">{props.note}</span>}
      </div>
      <div className="form-section__body">{props.children}</div>
    </section>
  );
}

export function PageHeader(props: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <>
      <div className="settings-page__header">
        <h1>{props.title}</h1>
        {props.children && <div className="settings-page__actions">{props.children}</div>}
      </div>
      {props.description && <p className="settings-page__desc">{props.description}</p>}
    </>
  );
}

/** Full-width search box; `children` renders trailing controls (filters). */
export function SearchField(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  children?: ReactNode;
}) {
  return (
    <div className="search-row">
      <div className="search-field">
        <Icon name="search" size={13} className="search-field__icon" />
        <input
          className="input search-field__input"
          type="search"
          placeholder={props.placeholder ?? "Search…"}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {props.value && (
          <button className="search-field__clear" title="Clear" onClick={() => props.onChange("")}>
            <Icon name="close" size={11} />
          </button>
        )}
      </div>
      {props.children}
    </div>
  );
}

/**
 * Rows container. `card` frames them with hairline separators (settings lists),
 * `grid` lays them out two-per-row without a frame (marketplace listings).
 */
export function RowList({ variant = "card", children }: { variant?: "card" | "grid" | "plain"; children: ReactNode }) {
  return <div className={`row-list row-list--${variant}`}>{children}</div>;
}

/** A single list row: icon tile, title (+ tags), one-line description, controls. */
export function Row(props: {
  icon?: ReactNode;
  title: ReactNode;
  tags?: ReactNode;
  description?: ReactNode;
  /** Variable-width status shown before the controls (test results, counts). */
  aside?: ReactNode;
  /**
   * Toggles, buttons and overflow menus. These sit in a fixed-width cluster so
   * they line up in a column down the list however wide `aside` gets.
   */
  actions?: ReactNode;
  onClick?: () => void;
}) {
  const El = props.onClick ? "button" : "div";
  return (
    <El className={`row${props.onClick ? " row--clickable" : ""}`} onClick={props.onClick}>
      {props.icon}
      <div className="row__main">
        <div className="row__title">
          <span className="row__name">{props.title}</span>
          {props.tags}
        </div>
        {props.description && <div className="row__desc">{props.description}</div>}
      </div>
      {props.aside && <div className="row__aside">{props.aside}</div>}
      {props.actions && <div className="row__actions">{props.actions}</div>}
    </El>
  );
}

const TILE_GLYPH_SIZE = { sm: 13, md: 16, lg: 19 } as const;
const TILE_MARK_SIZE = { sm: 14, md: 17, lg: 21 } as const;

/**
 * Rounded app-icon tile. Resolves a vendor logo from `id` where one exists — so
 * Cloudflare, GitHub and Stripe rows carry their real marks — and otherwise
 * falls back to the caller's glyph, so no entry is ever left without an icon.
 * The tint follows the logo, an explicit `color` from a manifest, or a hash of
 * the name.
 */
export function IconTile({
  name,
  id,
  color,
  icon,
  size = "md",
}: {
  name: string;
  /** Identifiers to resolve a logo from, most specific first (catalog id, host module, vendor). */
  id?: string | (string | undefined)[];
  /** Brand color declared by a manifest; overrides the resolved logo's tint. */
  color?: string;
  /** Glyph to fall back to when no logo matches. */
  icon?: IconName;
  size?: "sm" | "md" | "lg";
}) {
  // Only `id` feeds the logo lookup: `name` is free text, and a user's skill
  // called "security" should not pick up the Security plugin's glyph.
  const mark = id === undefined ? undefined : markFor(...(Array.isArray(id) ? id : [id]));
  // Custom properties, so typed as a plain record and cast at the boundary.
  const style: Record<string, string> = {};
  if (color) {
    style["--tile-color"] = color;
  } else if (mark?.kind === "glyph") {
    style["--tile-color-dark"] = mark.glyph.dark;
    style["--tile-color-light"] = mark.glyph.light;
  } else if (mark?.kind === "brand" && mark.brand.dark && mark.brand.light) {
    style["--tile-color-dark"] = mark.brand.dark;
    style["--tile-color-light"] = mark.brand.light;
  } else if (mark?.kind === "brand") {
    // A black or near-black logo; carry it in the theme's text color.
    style["--tile-color"] = "var(--color-text)";
  } else {
    const tint = tileTints(name);
    style["--tile-color-dark"] = tint.dark;
    style["--tile-color-light"] = tint.light;
  }

  return (
    <span className={`tile tile--${size}`} style={style as CSSProperties} aria-hidden>
      {mark?.kind === "brand" ? (
        <BrandMark brand={mark.brand} size={TILE_MARK_SIZE[size]} />
      ) : (
        <Icon name={mark?.glyph.icon ?? icon ?? "puzzle"} size={TILE_GLYPH_SIZE[size]} />
      )}
    </span>
  );
}

/**
 * Deterministic tint for entries with no logo, so each keeps a stable identity
 * color. Two lightnesses: the same hue has to carry on both themes.
 */
function tileTints(seed: string): { dark: string; light: string } {
  let hue = 0;
  for (let i = 0; i < seed.length; i++) hue = (hue * 31 + seed.charCodeAt(i)) % 360;
  return { dark: `hsl(${hue} 55% 62%)`, light: `hsl(${hue} 55% 40%)` };
}

export function Tag({ children, tone }: { children: ReactNode; tone?: "muted" | "ok" | "warn" | "bad" }) {
  return <span className={`tag${tone ? ` tag--${tone}` : ""}`}>{children}</span>;
}

export interface MenuAction {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * "…" overflow menu for a row.
 *
 * The panel renders into <body> rather than next to the button: settings lists
 * clip their content to keep their rounded corners, which would slice the menu
 * off. Being in the body also lets it flip above the button near the bottom of
 * the window instead of running off-screen.
 */
export function RowMenu({ items }: { items: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const GAP = 6;
    const EDGE = 8;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current?.getBoundingClientRect();
      if (!a || !p) return;
      const fitsBelow = a.bottom + GAP + p.height <= window.innerHeight - EDGE;
      const fitsAbove = a.top - GAP - p.height >= EDGE;
      setPos({
        top: fitsBelow || !fitsAbove ? a.bottom + GAP : a.top - GAP - p.height,
        // Right-aligned to the button, then kept inside the window.
        left: Math.max(EDGE, Math.min(a.right - p.width, window.innerWidth - EDGE - p.width)),
      });
    };
    place();
    window.addEventListener("resize", place);
    // Capture phase: the settings pane scrolls, not the window.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchor.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (items.length === 0) return null;

  const toggle = () => {
    setPos(null);
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={anchor}
        className={`icon-btn icon-btn--small${open ? " icon-btn--active" : ""}`}
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <Icon name="dots" size={14} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            className="menu__panel menu__panel--compact menu__panel--anchored"
            // Hidden for the first frame, while the panel is measured in place.
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                className={`menu__item${item.danger ? " menu__item--danger" : ""}`}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon && <Icon name={item.icon} size={13} />}
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Placeholder shown when a filtered list comes back empty. */
export function EmptyState({ icon, title, hint }: { icon?: IconName; title: string; hint?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <Icon name={icon} size={18} />}
      <div className="empty-state__title">{title}</div>
      {hint && <div className="empty-state__hint">{hint}</div>}
    </div>
  );
}
