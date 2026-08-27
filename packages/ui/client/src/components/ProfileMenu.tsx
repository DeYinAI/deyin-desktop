import { useEffect, useRef, useState, type ReactNode } from "react";
import { LOCALES } from "@deyin/host-core/shared";
import { useT } from "../i18n.js";
import { Icon, type IconName } from "./Icon.js";
import type { DeyinSettings, UserProfile } from "@deyin/contract";

interface ProfileMenuProps {
  platform: "desktop" | "web";
  user: UserProfile | null;
  busy: boolean;
  connecting: boolean;
  settings: DeyinSettings;
  onChangeSettings: (patch: Partial<DeyinSettings>) => void;
  onConnect: () => void;
  onLogout: () => void;
  onOpenUsage: () => void;
  onOpenPlans: () => void;
}

type SubmenuId = "language" | "theme" | "zoom" | null;

const ZOOM_PRESETS: { labelKey: "profile.zoom90" | "profile.zoom100" | "profile.zoom115" | "profile.zoom130"; size: number }[] = [
  { labelKey: "profile.zoom90", size: 12 },
  { labelKey: "profile.zoom100", size: 14 },
  { labelKey: "profile.zoom115", size: 16 },
  { labelKey: "profile.zoom130", size: 18 },
];

function initials(name?: string): string {
  if (!name) return "D";
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function isFreePlan(plan?: string): boolean {
  if (!plan) return true;
  return plan.trim().toLowerCase() === "free";
}

function SubmenuRow(props: {
  icon: IconName;
  label: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`menu__sub${props.open ? " menu__sub--open" : ""}`}
      onMouseEnter={props.onOpen}
      onMouseLeave={props.onClose}
    >
      <button type="button" className="menu__item" onClick={props.onToggle}>
        <Icon name={props.icon} size={13} />
        <span className="menu__item__label">{props.label}</span>
        <Icon name="chevronRight" size={12} className="menu__item__chevron" />
      </button>
      {props.open && (
        <div className="menu__panel menu__subpanel">{props.children}</div>
      )}
    </div>
  );
}

export function ProfileMenu({
  platform: _platform,
  user,
  busy,
  connecting,
  settings,
  onChangeSettings,
  onConnect,
  onLogout,
  onOpenUsage,
  onOpenPlans,
}: ProfileMenuProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<SubmenuId>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSubmenu(null);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (submenu) setSubmenu(null);
        else setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open, submenu]);

  if (!user) {
    const pending = busy || connecting;
    return (
      <button className="connect-row" disabled={pending} onClick={onConnect} title={t("profile.connect")}>
        <span className="connect-row__icon">
          <Icon name="user" size={14} />
        </span>
        <span>{pending ? t("profile.connecting") : t("profile.connect")}</span>
      </button>
    );
  }

  const freePlan = isFreePlan(user.plan);
  const planLabel = user.plan ?? null;

  const nearestZoom = ZOOM_PRESETS.reduce((best, preset) =>
    Math.abs(preset.size - settings.fontSize) < Math.abs(best.size - settings.fontSize) ? preset : best,
  );

  const closeMenu = () => {
    setOpen(false);
    setSubmenu(null);
  };

  const pickSubmenu = (id: SubmenuId) => setSubmenu((cur) => (cur === id ? null : id));

  const closeSubmenu = (id: SubmenuId) => setSubmenu((cur) => (cur === id ? null : cur));

  const themeOptions: { value: DeyinSettings["theme"]; labelKey: "appearance.dark" | "appearance.light" | "appearance.system" }[] = [
    { value: "dark", labelKey: "appearance.dark" },
    { value: "light", labelKey: "appearance.light" },
    { value: "system", labelKey: "appearance.system" },
  ];

  return (
    <div className="menu" ref={rootRef}>
      <button
        className="connect-row connect-row--profile"
        onClick={() => {
          if (open) setSubmenu(null);
          setOpen((v) => !v);
        }}
      >
        <span className="avatar">
          {user.picture ? <img src={user.picture} alt="" /> : initials(user.name)}
        </span>
        <span className="connect-row__stack">
          <span className="connect-row__name">{user.name ?? user.email ?? "Signed in"}</span>
          {planLabel && <span className="connect-row__plan">{planLabel}</span>}
        </span>
      </button>
      {open && (
        <div
          className="menu__panel menu__panel--up profilemenu"
          onMouseLeave={() => setSubmenu(null)}
        >
          <div className="profile-card" onMouseEnter={() => setSubmenu(null)}>
            <div className="profile-card__name">{user.name ?? "Deyin user"}</div>
            <div className="profile-card__email">{user.email}</div>
            {planLabel && <span className="plan-badge">{planLabel}</span>}
          </div>

          <SubmenuRow
            icon="globe"
            label={t("profile.language")}
            open={submenu === "language"}
            onOpen={() => setSubmenu("language")}
            onClose={() => closeSubmenu("language")}
            onToggle={() => pickSubmenu("language")}
          >
            {LOCALES.map((locale) => (
              <button
                key={locale.id}
                type="button"
                className={`menu__item ${settings.language === locale.id ? "menu__item--checked" : ""}`}
                onClick={() => {
                  onChangeSettings({ language: locale.id });
                  closeMenu();
                }}
              >
                <span className="menu__item__label">{locale.label}</span>
                {settings.language === locale.id && <Icon name="check" size={12} className="menu__item__check" />}
              </button>
            ))}
          </SubmenuRow>

          <SubmenuRow
            icon="palette"
            label={t("profile.appTheme")}
            open={submenu === "theme"}
            onOpen={() => setSubmenu("theme")}
            onClose={() => closeSubmenu("theme")}
            onToggle={() => pickSubmenu("theme")}
          >
            {themeOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`menu__item ${settings.theme === opt.value ? "menu__item--checked" : ""}`}
                onClick={() => {
                  onChangeSettings({ theme: opt.value });
                  closeMenu();
                }}
              >
                <span className="menu__item__label">{t(opt.labelKey)}</span>
                {settings.theme === opt.value && <Icon name="check" size={12} className="menu__item__check" />}
              </button>
            ))}
          </SubmenuRow>

          <SubmenuRow
            icon="zoom"
            label={t("profile.interfaceZoom")}
            open={submenu === "zoom"}
            onOpen={() => setSubmenu("zoom")}
            onClose={() => closeSubmenu("zoom")}
            onToggle={() => pickSubmenu("zoom")}
          >
            {ZOOM_PRESETS.map((preset) => (
              <button
                key={preset.size}
                type="button"
                className={`menu__item ${nearestZoom.size === preset.size ? "menu__item--checked" : ""}`}
                onClick={() => {
                  onChangeSettings({ fontSize: preset.size });
                  closeMenu();
                }}
              >
                <span className="menu__item__label">{t(preset.labelKey)}</span>
                {nearestZoom.size === preset.size && <Icon name="check" size={12} className="menu__item__check" />}
              </button>
            ))}
          </SubmenuRow>

          <div className="modelmenu__rule" onMouseEnter={() => setSubmenu(null)} />

          <button
            type="button"
            className="menu__item"
            onMouseEnter={() => setSubmenu(null)}
            onClick={() => {
              closeMenu();
              onOpenUsage();
            }}
          >
            <Icon name="chart" size={13} />
            <span className="menu__item__label">{t("profile.usageStats")}</span>
          </button>

          <button
            type="button"
            className={`menu__item ${freePlan ? "menu__item--accent" : ""}`}
            onMouseEnter={() => setSubmenu(null)}
            onClick={() => {
              closeMenu();
              onOpenPlans();
            }}
          >
            <Icon name="rocket" size={13} />
            <span className="menu__item__label">
              {freePlan ? t("profile.upgrade") : `${t("profile.plan")}: ${planLabel}`}
            </span>
          </button>

          <div className="modelmenu__rule" onMouseEnter={() => setSubmenu(null)} />

          <button
            type="button"
            className="menu__item"
            onMouseEnter={() => setSubmenu(null)}
            onClick={() => {
              closeMenu();
              onLogout();
            }}
          >
            <Icon name="logout" size={13} />
            <span className="menu__item__label">{t("profile.signOut")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
