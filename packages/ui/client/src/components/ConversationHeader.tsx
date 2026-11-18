import { useRef, useState, type ReactNode } from "react";
import type { ChatMode } from "@deyin/contract";
import { Icon, type IconName } from "./Icon.js";
import { ThreadMenu, type ThreadAction } from "./ThreadMenu.js";

interface ConversationHeaderProps {
  platform: "desktop" | "web";
  /** Hosted chat-only web: hide workspace folder chip and agent panel toggles. */
  chatOnly?: boolean;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  threadId: string | null;
  threadTitle: string;
  threadPinned: boolean;
  workspaceRoot: string | null;
  panelOpen: boolean;
  terminalOpen: boolean;
  mcpCount?: number;
  onOpenMcp?: () => void;
  onTogglePanel: () => void;
  onToggleTerminal: () => void;
  onThreadAction: (threadId: string, action: ThreadAction) => void;
  /** Extra controls on the right edge (environment badge, repo bar). */
  trailing?: ReactNode;
}

const MODE_LABEL: Record<ChatMode, { icon: IconName; label: string }> = {
  agent: { icon: "bolt", label: "Build mode" },
  plan: { icon: "route", label: "Plan mode" },
  ask: { icon: "message", label: "Ask mode" },
  delivery: { icon: "rocket", label: "Delivery mode" },
  bot: { icon: "bot", label: "Bot mode" },
};

/** Session header above the conversation: title, mode chip, and the run controls. */
export function ConversationHeader(props: ConversationHeaderProps) {
  const chatOnly = props.chatOnly === true;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const mode = MODE_LABEL[props.mode];

  return (
    <div className="convo-head">
      <div className="convo-head__main">
        <h1 className="convo-head__title" title={props.threadTitle}>
          {props.threadTitle}
        </h1>
        <button
          type="button"
          className={`convo-head__mode${props.mode === "plan" ? " convo-head__mode--plan" : ""}`}
          title={`${mode.label}. Click to switch between Plan and Build.`}
          onClick={() => props.onModeChange(props.mode === "plan" ? "agent" : "plan")}
        >
          <Icon name={mode.icon} size={13} />
          <span>{mode.label}</span>
        </button>
      </div>

      <div className="convo-head__actions">
        {props.trailing}
        {props.mcpCount !== undefined && props.mcpCount > 0 && (
          <button
            type="button"
            className="convo-head__pill"
            title={`${props.mcpCount} active MCP servers. Click to view.`}
            onClick={props.onOpenMcp}
          >
            <span className="convo-head__dot" />
            <Icon name="plug" size={12} />
            <span>{props.mcpCount}</span>
          </button>
        )}
        <div className="menu">
          <button
            ref={menuBtnRef}
            type="button"
            className="icon-btn"
            title="Session actions"
            disabled={!props.threadId}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="dots" size={15} />
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
        {!chatOnly && (
          <>
            <button
              type="button"
              className={`icon-btn${props.terminalOpen ? " icon-btn--active" : ""}`}
              title="Toggle terminal"
              onClick={props.onToggleTerminal}
            >
              <Icon name="terminal" size={15} />
            </button>
            <button
              type="button"
              className={`icon-btn${props.panelOpen ? " icon-btn--active" : ""}`}
              title="Toggle workspace panel"
              onClick={props.onTogglePanel}
            >
              <Icon name="panel" size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
