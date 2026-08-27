import { useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { CoBrandLogos } from "./CoBrandLogos.js";
import { ThreadMenu, type ThreadAction } from "./ThreadMenu.js";

interface TopBarProps {
  platform: "desktop" | "web";
  /** Hosted chat-only web: hide workspace folder chip and agent panel toggles. */
  chatOnly?: boolean;
  threadId: string | null;
  threadTitle: string;
  threadPinned: boolean;
  projectName: string;
  workspaceRoot: string | null;
  panelOpen: boolean;
  terminalOpen: boolean;
  /** Session prefix cache hit rate (0–1), when measured. */
  cacheHitRate?: number | null;
  sessionCacheHit?: number;
  sessionCacheMiss?: number;
  /** Live token counters for the session. */
  tokenStats?: {
    inputCached: number;
    inputUncached: number;
    output: number;
    sessionTotal: number;
  } | null;
  onOpenFolder: () => void;
  onTogglePanel: () => void;
  onToggleTerminal: () => void;
  onThreadAction: (threadId: string, action: ThreadAction) => void;
}

function cacheHitTone(rate: number): "good" | "warn" | "bad" {
  if (rate >= 0.8) return "good";
  if (rate >= 0.5) return "warn";
  return "bad";
}

function formatCachePct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Custom title bar: brand, session breadcrumb, layout toggles, window controls. */
export function TopBar(props: TopBarProps) {
  const isDesktop = props.platform === "desktop";
  const isMac = isDesktop && navigator.platform.toLowerCase().includes("mac");
  const chatOnly = props.chatOnly === true;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <header className="titlebar">
      <div className={`titlebar__left ${isMac ? "titlebar__left--mac" : ""}`}>
        <span className="titlebar__logo"><CoBrandLogos size={20} /></span>
        <span className="titlebar__thread">{props.threadTitle}</span>
        {!chatOnly && (
        <button className="titlebar__project" onClick={props.onOpenFolder} title="Open folder">
          <Icon name="folder" size={13} />
          <span>{props.projectName}</span>
        </button>
        )}
        <div className="menu">
          <button
            ref={menuBtnRef}
            className="icon-btn"
            title="Task actions"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="dots" size={14} />
          </button>
          {menuOpen && props.threadId && (
            <ThreadMenu
              threadId={props.threadId}
              pinned={props.threadPinned}
              platform={props.platform}
              workspaceRoot={props.workspaceRoot}
              anchorRef={menuBtnRef}
              onAction={(action) => props.onThreadAction(props.threadId!, action)}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
      </div>

      <div className="titlebar__drag" />

      <div className="titlebar__right">
        {props.cacheHitRate != null && (
          <span
            className={`titlebar__cache titlebar__cache--${cacheHitTone(props.cacheHitRate)}`}
            title={[
              `Prefix cache hit rate: ${formatCachePct(props.cacheHitRate)}`,
              props.sessionCacheHit != null && props.sessionCacheMiss != null
                ? `Cached: ${props.sessionCacheHit.toLocaleString()} · Uncached: ${props.sessionCacheMiss.toLocaleString()}`
                : "",
            ]
              .filter(Boolean)
              .join("\n")}
          >
            <Icon name="sparkles" size={12} />
            <span>{formatCachePct(props.cacheHitRate)} cache</span>
          </span>
        )}
        {props.tokenStats && (
          <span className="titlebar__tokens" title="Session token totals">
            <span className="titlebar__token-seg" title="Cached input tokens">
              ↓{formatCompact(props.tokenStats.inputCached)}
            </span>
            <span className="titlebar__token-seg" title="Uncached input tokens">
              ↓{formatCompact(props.tokenStats.inputUncached)}
            </span>
            <span className="titlebar__token-seg" title="Output tokens">
              ↑{formatCompact(props.tokenStats.output)}
            </span>
          </span>
        )}
        {!chatOnly && (
        <>
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
        </>
        )}

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
