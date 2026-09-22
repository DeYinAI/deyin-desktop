import type { ChatMode } from "@deyin/contract";
import { useT } from "../i18n.js";
import { Icon, type IconName } from "./Icon.js";
import { UpdateBanner } from "./UpdateBanner.js";

interface NavRailProps {
  /** Which top-level view is showing, so its rail button reads as selected. */
  activeView?: "workspace" | "settings" | "upgrade" | "automations" | "bot" | "workflows";
  platform?: "desktop" | "web";
  currentMode?: ChatMode;
  onSwitchMode?: (mode: ChatMode) => void;
  onSelectView?: (view: "workspace" | "bot") => void;
  onExpand: () => void;
  onNewTask: () => void;
  onOpenSearch: () => void;
  onOpenAutomations: () => void;
  onOpenWorkflows?: () => void;
  onOpenCustomize: () => void;
  onOpenSettings: () => void;
}

/** Collapsed-sidebar stand-in: the sidebar's nav actions as a narrow icon strip,
 *  mirroring the workspace panel's rail on the opposite edge. The expand control
 *  lives here rather than in the title bar, so the sidebar owns its own toggle. */
export function NavRail(props: NavRailProps) {
  const t = useT();
  const isBot =
    props.activeView === "bot" ||
    props.activeView === "workflows" ||
    (props.activeView !== "workspace" && props.currentMode === "bot");

  const items: { icon: IconName; label: string; onClick: () => void; active?: boolean }[] = [
    { icon: "sparkles", label: isBot ? "New Mission" : t("nav.newTask"), onClick: props.onNewTask },
    { icon: "search", label: t("nav.search"), onClick: props.onOpenSearch },
    ...(isBot && props.onOpenWorkflows
      ? [{
          icon: "bolt" as IconName,
          label: "Workflows",
          onClick: props.onOpenWorkflows,
          active: props.activeView === "workflows",
        }]
      : []),
    ...(props.platform !== "web"
      ? [{
          icon: "automation" as IconName,
          label: t("nav.automations"),
          onClick: props.onOpenAutomations,
          active: props.activeView === "automations",
        }]
      : []),
    { icon: "customize", label: t("nav.customize"), onClick: props.onOpenCustomize },
    ...(props.onSelectView || props.onSwitchMode
      ? [
          {
            icon: "layout" as IconName,
            label: "Workspace",
            onClick: () => {
              props.onSelectView?.("workspace");
              props.onSwitchMode?.("agent");
            },
            active: !isBot,
          },
          {
            icon: "bot" as IconName,
            label: "Bot Mode",
            onClick: () => {
              props.onSelectView?.("bot");
              props.onSwitchMode?.("bot");
            },
            active: isBot,
          },
        ]
      : []),
  ];

  return (
    <nav className="nav-rail" aria-label="Navigation">
      <button
        type="button"
        className="nav-rail__btn"
        title={t("nav.expandSidebar")}
        aria-label={t("nav.expandSidebar")}
        onClick={props.onExpand}
      >
        <Icon name="panelLeft" size={14} />
      </button>

      <div className="nav-rail__items">
        {items.map((item) => (
          <button
            key={item.icon}
            type="button"
            className={`nav-rail__btn${item.active ? " nav-rail__btn--active" : ""}`}
            title={item.label}
            aria-label={item.label}
            onClick={item.onClick}
          >
            <Icon name={item.icon} size={14} />
          </button>
        ))}
      </div>

      <div className="nav-rail__footer">
        <UpdateBanner variant="rail" />
        <button
          type="button"
          className="nav-rail__btn"
          title={t("nav.settings")}
          aria-label={t("nav.settings")}
          onClick={props.onOpenSettings}
        >
          <Icon name="gear" size={14} />
        </button>
      </div>
    </nav>
  );
}
