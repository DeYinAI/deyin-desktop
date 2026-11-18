import { Icon } from "./Icon.js";
import type { PanelTab } from "./panelTypes.js";

export interface StripTab {
  id: PanelTab;
  label: string;
  icon: string;
  /** Small count/label next to the title (running subagents, pending diff). */
  badge?: string | number;
}

interface PanelTabStripProps {
  tabs: StripTab[];
  /** Selected tab; null while the Start page is showing. */
  activeId: PanelTab | null;
  fullscreen: boolean;
  onSelect: (tab: PanelTab) => void;
  onClose: (tab: PanelTab) => void;
  /** The "+" control: opens the Start page. */
  onAdd: () => void;
  onToggleFullscreen: () => void;
  onClosePanel: () => void;
}

/** Horizontal tab strip of the right panel: open tabs with hairline separators,
 *  a trailing "+" for the Start page, and panel controls at the far edge. */
export function PanelTabStrip(props: PanelTabStripProps) {
  return (
    <div className="pstrip" role="tablist" aria-label="Workspace tabs">
      <div className="pstrip__tabs">
        {props.tabs.map((tab, i) => {
          const active = props.activeId === tab.id;
          const next = props.tabs[i + 1];
          const hideSlot = active || next?.id === props.activeId;
          return (
            <div key={tab.id} className="pstrip__item">
              <div
                role="tab"
                tabIndex={0}
                aria-selected={active}
                className={`ptab${active ? " ptab--active" : ""}`}
                title={tab.label}
                onClick={() => props.onSelect(tab.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) props.onClose(tab.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onSelect(tab.id);
                  }
                }}
              >
                <span className="ptab__title">
                  <Icon name={tab.icon} size={13} className="ptab__icon" />
                  <span className="ptab__text">{tab.label}</span>
                  {tab.badge !== undefined && <span className="ptab__badge">{tab.badge}</span>}
                </span>
                <button
                  type="button"
                  className="ptab__close"
                  title={`Close ${tab.label}`}
                  aria-label={`Close ${tab.label}`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onClose(tab.id);
                  }}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
              {i < props.tabs.length - 1 && (
                <span className={`pstrip__slot${hideSlot ? " pstrip__slot--hidden" : ""}`} aria-hidden />
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        role="tab"
        aria-selected={props.activeId === null}
        className={`pstrip__add${props.activeId === null ? " pstrip__add--active" : ""}`}
        title="New tab"
        aria-label="New tab"
        onClick={props.onAdd}
      >
        <Icon name="plus" size={14} />
      </button>
      <div className="pstrip__fill" />
      <div className="pstrip__chrome">
        <button
          type="button"
          className="pstrip__btn"
          title={props.fullscreen ? "Exit full screen" : "Full screen"}
          aria-label={props.fullscreen ? "Exit full screen" : "Full screen"}
          aria-pressed={props.fullscreen}
          onClick={props.onToggleFullscreen}
        >
          <Icon name="zoom" size={14} />
        </button>
        <button type="button" className="pstrip__btn" title="Close panel" aria-label="Close panel" onClick={props.onClosePanel}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}
