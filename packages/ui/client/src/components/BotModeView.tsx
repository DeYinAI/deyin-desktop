import { memo, type ReactNode } from "react";
import type { ThreadEvent } from "@deyin/contract";
import type { ThreadRunSnapshot } from "../hooks/useAgentState.js";
import { ChatView, type ChatCodeDisplay } from "./ChatView.js";

const MemoChatView = memo(ChatView);

export interface BotModeViewProps {
  workspaceRoot: string | null;
  activeThreadId: string | null;
  chatEvents: ThreadEvent[];
  chatStreamText: string | null;
  chatStreamReasoning?: string | null;
  greetingName: string;
  agentRunState?: ThreadRunSnapshot | null;
  chatCodeDisplay: ChatCodeDisplay;
  onOpenFile: (path: string) => void;
  onOpenWorkspaceFile?: (path: string) => void;
  homeDir?: string | null;
  onUndo: (path: string, checkpointId: string) => void;
  onRevertRun?: (runId: string) => void;
  onEditMessage?: (eventIndex: number) => void;
  onForkAtEvent?: (eventIndex: number) => void;
  /** Optional message feedback (telemetry / analytics). `removed` marks a retraction. */
  onMessageFeedback?: (eventIndex: number, rating: "up" | "down", removed?: boolean) => void;
  onOpenAgentTerminal?: () => void;
  threadTitles?: Record<string, string>;
  /** Session header (title, mode chip, panel toggle): the same one the workspace view uses. */
  header: ReactNode;
  /** One-line strips docked above the composer (task list, run strip). */
  dock?: ReactNode;
  composerNode: ReactNode;
}

/**
 * Bot Mode is the ordinary conversation column with the orchestrator selected:
 * header, stream, docked strips, composer. A pipeline run is shown by the run
 * strip above the composer and the Bot Flow tab in the right panel, never by a
 * second pane. Pipelines are authored by typing `/pipeline` (or describing one).
 */
export function BotModeView(props: BotModeViewProps) {
  const isEmpty = props.chatEvents.length === 0 && props.chatStreamText === null;

  return (
    <main className={`chat-column${isEmpty ? " chat-column--empty" : ""}`}>
      {props.header}

      <MemoChatView
        events={props.chatEvents}
        streamText={props.chatStreamText}
        streamReasoning={props.chatStreamReasoning ?? null}
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

      {isEmpty && (
        <p className="bot-hint">
          Describe what you want built, or type <kbd>/pipeline</kbd> to set up a multi-agent pipeline step by step.
        </p>
      )}

      {props.dock}
      {props.composerNode}
    </main>
  );
}
