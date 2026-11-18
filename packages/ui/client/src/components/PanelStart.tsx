import { useState } from "react";
import { AnchoredMenu } from "./AnchoredMenu.js";
import { Icon, type IconName } from "./Icon.js";
import { PANEL_TABS } from "./panelTabs.js";
import type { PanelTab } from "./panelTypes.js";

interface PanelStartProps {
  /** Chat-only web: only the Preview view exists. */
  previewOnly?: boolean;
  onOpen: (tab: PanelTab) => void;
}

interface StartEntry {
  tab: PanelTab;
  icon: IconName;
  title: string;
  description: string;
  hint?: string;
}

const ENTRIES: StartEntry[] = [
  { tab: "files", icon: "folderOpen", title: "Workspace files", description: "Browse files in this session's workspace" },
  { tab: "terminal", icon: "terminal", title: "New terminal", description: "Run commands in the session workspace", hint: "Ctrl+`" },
  { tab: "browser", icon: "globe", title: "Browser", description: "Browse web pages" },
];

/** Tools reachable through the "More tools" capsule (everything not on the main list). */
const MORE_TABS = PANEL_TABS.filter((t) => !ENTRIES.some((e) => e.tab === t.id));

/** The panel's Start page: capsule launchers for each tool, like a new-tab page. */
export function PanelStart(props: PanelStartProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const entries = props.previewOnly ? [] : ENTRIES;

  return (
    <div className="pstart">
      <div className="pstart__hero" aria-hidden>
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="28" cy="28" r="20" />
          <path d="M36.5 19.5L31.5 31.5L19.5 36.5L24.5 24.5Z" />
          <circle cx="28" cy="28" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      </div>
      {props.previewOnly && (
        <button type="button" className="pstart__entry" onClick={() => props.onOpen("preview")}>
          <span className="pstart__icon"><Icon name="layout" size={20} /></span>
          <span className="pstart__text">
            <span className="pstart__title">Preview</span>
            <span className="pstart__desc">View the page the agent built</span>
          </span>
        </button>
      )}
      {entries.map((entry) => (
        <button key={entry.tab} type="button" className="pstart__entry" onClick={() => props.onOpen(entry.tab)}>
          <span className="pstart__icon"><Icon name={entry.icon} size={20} /></span>
          <span className="pstart__text">
            <span className="pstart__title">{entry.title}</span>
            <span className="pstart__desc">{entry.description}</span>
          </span>
          {entry.hint && <span className="pstart__hint">{entry.hint}</span>}
        </button>
      ))}
      {!props.previewOnly && (
        <div className="pstart__more">
          <AnchoredMenu
            open={moreOpen}
            onToggle={() => setMoreOpen((v) => !v)}
            onClose={() => setMoreOpen(false)}
            triggerClassName="pstart__entry"
            triggerTitle="More tools"
            trigger={
              <>
                <span className="pstart__icon"><Icon name="grid" size={20} /></span>
                <span className="pstart__text">
                  <span className="pstart__title">More tools</span>
                </span>
                <Icon name="chevronDown" size={14} />
              </>
            }
            panelClassName="sb-menu"
          >
            {MORE_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className="menu__item"
                onClick={() => {
                  setMoreOpen(false);
                  props.onOpen(tab.id);
                }}
              >
                <Icon name={tab.icon} size={15} />
                <span>{tab.label}</span>
              </button>
            ))}
          </AnchoredMenu>
        </div>
      )}
    </div>
  );
}
