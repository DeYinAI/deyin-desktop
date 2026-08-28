import { Icon } from "./Icon.js";
import { PANEL_TABS } from "./panelTabs.js";
import type { PanelTab } from "./panelTypes.js";

interface PanelRailProps {
  activeTab: PanelTab;
  collapsed: boolean;
  /** Diff tab has pending content. */
  diffDot?: boolean;
  /** Running subagent count (Agent tab badge). */
  agentCount?: number;
  /** Chat-only web: show only the Preview tab. */
  previewOnly?: boolean;
  onSelectTab: (tab: PanelTab) => void;
  /** Hide the rail entirely (chat goes full width). */
  onDismiss?: () => void;
}

/** Vertical icon strip for the right workspace panel — visible when collapsed or expanded. */
export function PanelRail(props: PanelRailProps) {
  const tabs = props.previewOnly ? PANEL_TABS.filter((tab) => tab.id === "preview") : PANEL_TABS;
  return (
    <nav className={`panel-rail${props.collapsed ? " panel-rail--solo" : ""}`} aria-label="Workspace views">
      <div className="panel-rail__tabs">
        {tabs.map((tab) => {
          const active = props.activeTab === tab.id;
          const dot = tab.id === "diff" && props.diffDot;
          const badge = tab.id === "agent" && (props.agentCount ?? 0) > 0 ? props.agentCount : undefined;
          return (
            <button
              key={tab.id}
              type="button"
              className={`panel-rail__btn${active ? " panel-rail__btn--active" : ""}`}
              title={tab.label}
              aria-label={tab.label}
              aria-current={active ? "page" : undefined}
              onClick={() => props.onSelectTab(tab.id)}
            >
              <Icon name={tab.icon} size={16} />
              {dot && <span className="panel-rail__dot" />}
              {badge !== undefined && <span className="panel-rail__badge">{badge}</span>}
            </button>
          );
        })}
      </div>
      {props.collapsed && props.onDismiss && (
        <button
          type="button"
          className="panel-rail__dismiss"
          title="Hide panel"
          aria-label="Hide panel"
          onClick={props.onDismiss}
        >
          <Icon name="chevronsRight" size={14} />
        </button>
      )}
    </nav>
  );
}
