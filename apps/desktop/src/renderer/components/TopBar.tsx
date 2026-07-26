import { useState } from "react";
import { Icon } from "./Icon.js";
import { Logo } from "./Logo.js";
import { ThreadMenu, type ThreadAction } from "./ThreadMenu.js";

interface TopBarProps {
  platform: "desktop" | "web";
  threadId: string | null;
  threadTitle: string;
  threadPinned: boolean;
  projectName: string;
  workspaceRoot: string | null;
  panelOpen: boolean;
  terminalOpen: boolean;
  onOpenFolder: () => void;
  onTogglePanel: () => void;
  onToggleTerminal: () => void;
  onThreadAction: (threadId: string, action: ThreadAction) => void;
}

/** Custom title bar: brand, session breadcrumb, layout toggles, window controls. */
export function TopBar(props: TopBarProps) {
  const isDesktop = props.platform === "desktop";
  const isMac = isDesktop && navigator.platform.toLowerCase().includes("mac");
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="titlebar">
      <div className={`titlebar__left ${isMac ? "titlebar__left--mac" : ""}`}>
        <span className="titlebar__logo"><Logo size={20} /></span>
        <button className="icon-btn" title="Back" disabled>
          <Icon name="arrowLeft" size={14} />
        </button>
        <button className="icon-btn" title="Forward" disabled>
          <Icon name="arrowRight" size={14} />
        </button>
        <span className="titlebar__thread">{props.threadTitle}</span>
        <button className="titlebar__project" onClick={props.onOpenFolder} title="Open folder">
          <Icon name="folder" size={13} />
          <span>{props.projectName}</span>
        </button>
        <div className="menu">
          <button className="icon-btn" title="Task actions" onClick={() => setMenuOpen((v) => !v)}>
            <Icon name="dots" size={14} />
          </button>
          {menuOpen && props.threadId && (
            <ThreadMenu
              threadId={props.threadId}
              pinned={props.threadPinned}
              platform={props.platform}
              workspaceRoot={props.workspaceRoot}
              onAction={(action) => props.onThreadAction(props.threadId!, action)}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
      </div>

      <div className="titlebar__drag" />

      <div className="titlebar__right">
        <button
          className={`icon-btn ${props.terminalOpen ? "icon-btn--active" : ""}`}
          title="Toggle terminal"
          onClick={props.onToggleTerminal}
        >
          <Icon name="terminal" size={15} />
        </button>
        <button
          className={`icon-btn ${props.panelOpen ? "icon-btn--active" : ""}`}
          title="Toggle workspace panel"
          onClick={props.onTogglePanel}
        >
          <Icon name="panel" size={15} />
        </button>
        <button className="icon-btn" title="Layout">
          <Icon name="chevronDown" size={14} />
        </button>

        {isDesktop && !isMac && (
          <div className="titlebar__winctl">
            <button className="winctl" title="Minimize" onClick={() => window.deyin.win.minimize()}>
              <Icon name="minimize" size={13} />
            </button>
            <button className="winctl" title="Maximize" onClick={() => window.deyin.win.toggleMaximize()}>
              <Icon name="maximize" size={12} />
            </button>
            <button className="winctl winctl--close" title="Close" onClick={() => window.deyin.win.close()}>
              <Icon name="close" size={13} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
