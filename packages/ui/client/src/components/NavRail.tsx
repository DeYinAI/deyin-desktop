import type { ChatMode } from "@deyin/contract";
import { useT } from "../i18n.js";
import { Icon, type IconName } from "./Icon.js";
import { UpdateBanner } from "./UpdateBanner.js";

interface NavRailProps {
  /** Which top-level view is showing, so its rail button reads as selected. */
  activeView?: "workspace" | "settings" | "upgrade" | "automations" | "plugins" | "superagent" | "bot" | "workflows";
  platform?: "desktop" | "web";
  currentMode?: ChatMode;
  onSwitchMode?: (mode: ChatMode) => void;
  onSelectView?: (view: "workspace" | "bot") => void;
  onNewTask: () => void;
  onOpenPlugins: () => void;
  onOpenSearch: () => void;
  onOpenAutomations: () => void;
  onOpenSuperagent: () => void;
  onOpenWorkflows?: () => void;
  onOpenCustomize: () => void;
  onOpenSettings: () => void;
}

/** Collapsed-sidebar stand-in: the sidebar's nav actions as a narrow icon strip,
 *  mirroring the workspace panel's rail on the opposite edge. The expand control
 *  is the title bar's sidebar toggle. */
export function NavRail(props: NavRailProps) {
  const t = useT();
  const isBot =
    props.activeView === "bot" ||
    props.activeView === "workflows" ||
    (props.activeView !== "workspace" && props.currentMode === "bot");

  const items: { icon: IconName; label: string; onClick: () => void; active?: boolean }[] = [
    { icon: "plusCircle", label: isBot ? "New mission" : "New session", onClick: () => props.onNewTask() },
    { icon: "search", label: t("nav.search"), onClick: props.onOpenSearch },
    { icon: "puzzle", label: "Plugins", onClick: props.onOpenPlugins, active: props.activeView === "plugins" },
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
          icon: "clock" as IconName,
          label: "Automation tasks",
          onClick: props.onOpenAutomations,
          active: props.activeView === "automations",
        }]
      : []),
    ...(props.platform !== "web"
      ? [{
          icon: "rocket" as IconName,
          label: t("nav.superagent"),
          onClick: props.onOpenSuperagent,
          active: props.activeView === "superagent",
        }]
      : []),
    { icon: "palette", label: t("nav.customize"), onClick: props.onOpenCustomize },
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
