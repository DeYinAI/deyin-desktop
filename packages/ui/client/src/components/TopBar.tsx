import type { ReactNode } from "react";
import { Icon } from "./Icon.js";

interface TopBarProps {
  platform: "desktop" | "web";
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Thread history arrows, mirroring the browser-style back/forward pair. */
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  /** Right-side session controls, before the window buttons. */
  trailing?: ReactNode;
}

/** Slim custom title bar: sidebar toggle and history on the left, session controls
 *  and window buttons on the right. The folder and branch picker sits above the composer. */
export function TopBar(props: TopBarProps) {
  const isDesktop = props.platform === "desktop";
  const isMac = isDesktop && navigator.platform.toLowerCase().includes("mac");

  return (
    <header className="titlebar">
      <div className={`titlebar__left ${isMac ? "titlebar__left--mac" : ""}`}>
        <button
          type="button"
          className="icon-btn"
          title={props.sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          aria-label={props.sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          aria-pressed={props.sidebarOpen}
          onClick={props.onToggleSidebar}
        >
          <Icon name="panelLeft" size={16} />
        </button>
        <button type="button" className="icon-btn" title="Back" disabled={!props.canBack} onClick={props.onBack}>
          <Icon name="arrowLeft" size={15} />
        </button>
        <button type="button" className="icon-btn" title="Forward" disabled={!props.canForward} onClick={props.onForward}>
          <Icon name="arrowRight" size={15} />
        </button>
      </div>

      <div className="titlebar__drag" />

      {props.trailing && <div className="titlebar__trailing">{props.trailing}</div>}

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
    </header>
  );
}
