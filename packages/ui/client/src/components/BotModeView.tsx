import { memo, useMemo, useState } from "react";
import type { Thread, ThreadEvent } from "@deyin/contract";
import type { ThreadRunSnapshot } from "../hooks/useAgentState.js";
import { Icon } from "./Icon.js";
import { ChatView } from "./ChatView.js";
import { BotFlowPanel } from "./BotFlowPanel.js";

const MemoChatView = memo(ChatView);

export interface BotModeViewProps {
  workspaceRoot: string | null;
  projectName?: string;
  activeThread: Thread | null;
  activeThreadId: string | null;
  chatEvents: ThreadEvent[];
  chatStreamText: string | null;
  chatStreamReasoning?: string | null;
  greetingName?: string;
  agentRunState?: ThreadRunSnapshot | null;
  activeThreadStreaming: boolean;
  chatCodeDisplay: "preview" | "expanded";
  onOpenFile: (path: string, diff?: any) => void;
  onOpenWorkspaceFile?: (path: string) => void;
  homeDir?: string | null;
  onUndo: (path: string) => void;
  onRevertRun?: (runId: string) => void;
  onEditMessage?: (eventIndex: number, text: string) => void;
  onForkAtEvent?: (eventIndex: number) => void;
  onMessageFeedback?: (eventIndex: number, rating: "up" | "down") => void;
  onOpenAgentTerminal?: (threadId: string) => void;
  threadTitles?: Record<string, string>;
  onNewMission: () => void;
  onSwitchToWorkspace: () => void;
  onQuickPrompt?: (prompt: string) => void;
  onOpenWorkflows?: (workflowId?: string | null) => void;
  composerNode: React.ReactNode;
}

const QUICK_CHIPS = [
  {
    icon: "bolt" as const,
    label: "Tri-Bot Engineering Flow",
    prompt: "Run a 3-stage engineering pipeline: 1) Architecture Spec with Codex, 2) Implementation with Claude Code, 3) Validation with OpenCode.",
  },
  {
    icon: "shield" as const,
    label: "Review PR with Claude Code",
    prompt: "Delegate to Claude Code: Review the uncommitted changes and recent diff, checking for security vulnerabilities, edge-case regressions, and missing tests.",
  },
  {
    icon: "cpu" as const,
    label: "Architecture with Codex",
    prompt: "Delegate to OpenAI Codex CLI: Design the technical architecture and specifications for the requested feature in an isolated git worktree.",
  },
  {
    icon: "list" as const,
    label: "Run Tests with OpenCode",
    prompt: "Delegate to OpenCode: Run the test suite, report failing assertions, and recommend targeted fixes.",
  },
];

export function BotModeView(props: BotModeViewProps) {
  const [telemetryCollapsed, setTelemetryCollapsed] = useState(false);

  const isChatEmpty = useMemo(() => {
    return (
      props.chatEvents.length === 0 &&
      !props.chatStreamText &&
      !props.agentRunState?.running
    );
  }, [props.chatEvents.length, props.chatStreamText, props.agentRunState?.running]);

  return (
    <div className="bot-mode-view">
      {/* Left 60%: Conversational Orchestrator Chat */}
      <section className="bot-mode-view__chat-pane">
        {/* Mission Control Header */}
        <div className="bot-mode-view__header">
          <div className="bot-mode-view__header-meta">
            <span className="bot-mode-view__badge">
              <Icon name="bot" size={13} />
              <span>Bot Mode · Mission Control</span>
            </span>

            {props.projectName && (
              <span className="bot-mode-view__project-chip" title={props.workspaceRoot ?? props.projectName}>
                <Icon name="folder" size={12} />
                <span>{props.projectName}</span>
              </span>
            )}

            <span className="bot-mode-view__thread-title">
              {props.activeThread?.title || "Autonomous Multi-Agent Orchestrator"}
            </span>
          </div>

          <div className="bot-mode-view__header-actions">
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={props.onNewMission}
              title="Start a new multi-agent mission"
            >
              <Icon name="sparkles" size={12} />
              <span>New Mission</span>
            </button>

            <button
              type="button"
              className="icon-btn"
              onClick={() => setTelemetryCollapsed((v) => !v)}
              title={telemetryCollapsed ? "Show Telemetry HUD" : "Collapse Telemetry HUD"}
              aria-label={telemetryCollapsed ? "Show Telemetry HUD" : "Collapse Telemetry HUD"}
            >
              <Icon name={telemetryCollapsed ? "panelRight" : "panelRightClose"} size={14} />
            </button>
          </div>
        </div>

        {/* Quick Delegation Chips Row */}
        {isChatEmpty && (
          <div className="bot-mode-view__quick-chips">
            <div className="bot-mode-view__chips-label">
              <Icon name="sparkles" size={12} />
              <span>Quick Delegation Templates</span>
            </div>
            <div className="bot-mode-view__chips-row">
              {QUICK_CHIPS.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  className="bot-mode-view__chip"
                  onClick={() => props.onQuickPrompt?.(chip.prompt)}
                  title={chip.prompt}
                >
                  <Icon name={chip.icon} size={12} />
                  <span>{chip.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message Stream */}
        <div className="bot-mode-view__stream-container">
          <MemoChatView
            events={props.chatEvents}
            streamText={props.chatStreamText}
            streamReasoning={props.chatStreamReasoning}
            greetingName={props.greetingName}
            threadKey={props.activeThreadId}
            codeDisplay={props.chatCodeDisplay}
            onOpenFile={props.onOpenFile}
            onOpenWorkspaceFile={props.onOpenWorkspaceFile}
            workspaceRoot={props.workspaceRoot}
            homeDir={props.homeDir}
            onUndo={props.onUndo}
            onRevertRun={props.onRevertRun}
            onEditMessage={props.onEditMessage}
            agentRunning={props.agentRunState?.running ?? false}
            onForkAtEvent={props.onForkAtEvent}
            onMessageFeedback={props.onMessageFeedback}
            onOpenAgentTerminal={props.onOpenAgentTerminal}
            threadTitles={props.threadTitles}
          />
        </div>

        {/* Command Composer pinned at bottom */}
        <div className="bot-mode-view__composer-wrapper">
          {props.composerNode}
        </div>
      </section>

      {/* Right 40%: Live Pipeline & Telemetry HUD */}
      {!telemetryCollapsed && (
        <aside className="bot-mode-view__telemetry-pane" aria-label="Pipeline Telemetry and Execution Monitor">
          <div className="bot-mode-view__telemetry-header">
            <div className="bot-mode-view__telemetry-title">
              <Icon name="cpu" size={13} />
              <span>Pipeline Telemetry & Monitor</span>
            </div>
          </div>

          <div className="bot-mode-view__telemetry-body">
            <BotFlowPanel
              workspaceRoot={props.workspaceRoot}
              onOpenWorkflows={props.onOpenWorkflows}
            />
          </div>
        </aside>
      )}
    </div>
  );
}
