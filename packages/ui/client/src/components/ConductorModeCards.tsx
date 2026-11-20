import { useState } from "react";
import type {
  ConductorStageProgress,
  ConductorWorkflowDefinition,
} from "@deyin/contract";
import { Icon } from "./Icon.js";
import { FlatCard } from "./ui/index.js";

function formatSeconds(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/* 1. ConductorWorkflowCard -------------------------------------------------------- */

export interface ConductorWorkflowCardProps {
  workflow: ConductorWorkflowDefinition;
  isRunning?: boolean;
  onRun?: (workflowId: string) => void;
  onOpenFlowPanel?: () => void;
}

export function ConductorWorkflowCard({
  workflow,
  isRunning,
  onRun,
  onOpenFlowPanel,
}: ConductorWorkflowCardProps) {
  return (
    <FlatCard className="conductor-workflow-card">
      <div className="conductor-workflow-card__head">
        <div className="conductor-workflow-card__title-row">
          <Icon name="bot" size={16} className="conductor-workflow-card__icon" />
          <span className="conductor-workflow-card__title">{workflow.name}</span>
          {workflow.schedule?.enabled && (
            <span className="conductor-workflow-card__schedule-badge">
              <Icon name="time" size={11} />
              {workflow.schedule.cronExpression ?? `${workflow.schedule.intervalMinutes}m`}
            </span>
          )}
        </div>
        {workflow.description && (
          <p className="conductor-workflow-card__desc">{workflow.description}</p>
        )}
      </div>

      <div className="conductor-workflow-card__stages">
        <div className="conductor-workflow-card__stages-header">Pipeline Stages ({workflow.stages.length})</div>
        <div className="conductor-workflow-card__stages-list">
          {workflow.stages.map((stage, idx) => (
            <div key={stage.id} className="conductor-workflow-card__stage-row">
              <span className="conductor-workflow-card__stage-num">{idx + 1}</span>
              <span className="conductor-workflow-card__stage-name">{stage.name}</span>
              <span className="conductor-workflow-card__stage-agent">
                <Icon name="cpu" size={11} />
                {stage.agentId}
                {stage.modelOverride ? ` · ${stage.modelOverride}` : ""}
              </span>
              {stage.worktree?.isolate !== false && (
                <span className="conductor-workflow-card__stage-isolate" title="Isolated Git Worktree">
                  <Icon name="gitBranch" size={10} />
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="conductor-workflow-card__actions">
        <button
          type="button"
          className="btn btn--primary conductor-workflow-card__run-btn"
          disabled={isRunning}
          onClick={() => onRun?.(workflow.id)}
        >
          <Icon name={isRunning ? "spinner" : "bolt"} size={13} />
          <span>{isRunning ? "Pipeline running…" : "Run pipeline"}</span>
        </button>
        {onOpenFlowPanel && (
          <button
            type="button"
            className="btn btn--secondary conductor-workflow-card__hud-btn"
            onClick={onOpenFlowPanel}
          >
            <Icon name="layout" size={13} />
            <span>Open HUD</span>
          </button>
        )}
      </div>
    </FlatCard>
  );
}

/* 2. ConductorStageProgressCard --------------------------------------------------- */

export interface ConductorStageProgressCardProps {
  stage: ConductorStageProgress;
  onNudge?: (stageId: string) => void;
  onAbort?: (stageId: string) => void;
  onViewLogs?: (stageId: string) => void;
}

export function ConductorStageProgressCard({
  stage,
  onNudge,
  onAbort,
  onViewLogs,
}: ConductorStageProgressCardProps) {
  const isRunning = stage.status === "running";
  const isStalled = stage.status === "stalled";
  const isCompleted = stage.status === "completed";
  const isFailed = stage.status === "failed";

  return (
    <FlatCard
      className={`conductor-stage-card ${isRunning ? "conductor-stage-card--running" : ""} ${
        isStalled ? "conductor-stage-card--stalled" : ""
      } ${isCompleted ? "conductor-stage-card--completed" : ""} ${
        isFailed ? "conductor-stage-card--failed" : ""
      }`}
    >
      <div className="conductor-stage-card__head">
        <div className="conductor-stage-card__title-row">
          <span
            className={`conductor-stage-card__status-dot ${
              isRunning ? "conductor-stage-card__status-dot--pulse" : ""
            }`}
          />
          <span className="conductor-stage-card__name">{stage.stageName}</span>
          <span className="conductor-stage-card__agent-badge">
            <Icon name="cpu" size={11} />
            {stage.agentId}
          </span>
        </div>
        <div className="conductor-stage-card__timer">
          <Icon name="time" size={11} />
          <span>{formatSeconds(Math.round(stage.elapsedMs / 1000))}</span>
        </div>
      </div>

      <div className="conductor-stage-card__meta">
        {stage.branchName && (
          <span className="conductor-stage-card__meta-item" title="Git Worktree Branch">
            <Icon name="gitBranch" size={11} />
            <code>{stage.branchName}</code>
          </span>
        )}
        <span className="conductor-stage-card__meta-item">
          <span>❤️ {stage.heartbeatCount} heartbeats</span>
        </span>
        <span className="conductor-stage-card__meta-item">
          <span>📜 {stage.linesProduced} lines</span>
        </span>
      </div>

      {stage.outputSummary && (
        <div className="conductor-stage-card__summary">
          <pre>{stage.outputSummary.slice(0, 300)}</pre>
        </div>
      )}

      {stage.error && (
        <div className="conductor-stage-card__error">
          <Icon name="alertCircle" size={13} />
          <span>{stage.error}</span>
        </div>
      )}

      <div className="conductor-stage-card__actions">
        {isRunning && onNudge && (
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            onClick={() => onNudge(stage.stageId)}
          >
            Nudge
          </button>
        )}
        {onViewLogs && (
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            onClick={() => onViewLogs(stage.stageId)}
          >
            Logs
          </button>
        )}
        {isRunning && onAbort && (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => onAbort(stage.stageId)}
          >
            Stop
          </button>
        )}
      </div>
    </FlatCard>
  );
}

/* 3. ConductorWatchdogAlertCard --------------------------------------------------- */

export interface ConductorWatchdogAlertCardProps {
  stageName: string;
  agentId: string;
  inactiveSeconds: number;
  onNudge: () => void;
  onViewLogs: () => void;
  onRetry: () => void;
  onAbort: () => void;
}

export function ConductorWatchdogAlertCard({
  stageName,
  agentId,
  inactiveSeconds,
  onNudge,
  onViewLogs,
  onRetry,
  onAbort,
}: ConductorWatchdogAlertCardProps) {
  return (
    <FlatCard className="conductor-watchdog-card">
      <div className="conductor-watchdog-card__head">
        <Icon name="alertTriangle" size={16} className="conductor-watchdog-card__icon" />
        <span className="conductor-watchdog-card__title">Watchdog Inactivity Alert</span>
        <span className="conductor-watchdog-card__time">{inactiveSeconds}s silent</span>
      </div>

      <p className="conductor-watchdog-card__desc">
        Stage <strong>{stageName}</strong> (running on <code>{agentId}</code>) has emitted no output or heartbeats for {inactiveSeconds} seconds. The process may be waiting for an interactive prompt, terminal permission, or a slow build.
      </p>

      <div className="conductor-watchdog-card__actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={onNudge}>
          <Icon name="message" size={12} />
          <span>Nudge agent</span>
        </button>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onViewLogs}>
          <Icon name="terminal" size={12} />
          <span>Tail Logs</span>
        </button>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onRetry}>
          <Icon name="sync" size={12} />
          <span>Retry Stage</span>
        </button>
        <button type="button" className="btn btn--danger btn--sm" onClick={onAbort}>
          <Icon name="close" size={12} />
          <span>Abort</span>
        </button>
      </div>
    </FlatCard>
  );
}

/* 4. ConductorReviewMergeCard ----------------------------------------------------- */

export interface ConductorReviewMergeCardProps {
  workflowName: string;
  branchName: string;
  stagesCompleted: number;
  totalStages: number;
  diffSummary?: string;
  onMerge: (branch: string) => Promise<void> | void;
  onInspectDiff?: (branch: string) => void;
}

export function ConductorReviewMergeCard({
  workflowName,
  branchName,
  stagesCompleted,
  totalStages,
  diffSummary,
  onMerge,
  onInspectDiff,
}: ConductorReviewMergeCardProps) {
  const [merged, setMerged] = useState(false);
  const [merging, setMerging] = useState(false);

  const handleMerge = async () => {
    setMerging(true);
    try {
      await onMerge(branchName);
      setMerged(true);
    } finally {
      setMerging(false);
    }
  };

  return (
    <FlatCard className="conductor-merge-card">
      <div className="conductor-merge-card__head">
        <div className="conductor-merge-card__badge">
          <Icon name="checkCircle" size={16} />
        </div>
        <div className="conductor-merge-card__title-box">
          <div className="conductor-merge-card__title">{workflowName} Completed!</div>
          <div className="conductor-merge-card__subtitle">
            All {stagesCompleted}/{totalStages} pipeline stages succeeded in isolated worktrees.
          </div>
        </div>
      </div>

      <div className="conductor-merge-card__body">
        <div className="conductor-merge-card__branch">
          <Icon name="gitBranch" size={12} />
          <span>Result branch: <code>{branchName}</code></span>
        </div>

        {diffSummary && (
          <div className="conductor-merge-card__diff-preview">
            <pre>{diffSummary.slice(0, 400)}</pre>
          </div>
        )}
      </div>

      <div className="conductor-merge-card__actions">
        <button
          type="button"
          className={`btn ${merged ? "btn--subtle" : "btn--primary"}`}
          disabled={merged || merging}
          onClick={handleMerge}
        >
          <Icon name={merged ? "check" : "gitMerge"} size={13} />
          <span>{merged ? "Merged into Workspace" : merging ? "Merging…" : "1-Click Merge to Main"}</span>
        </button>

        {onInspectDiff && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => onInspectDiff(branchName)}
          >
            <Icon name="diff" size={13} />
            <span>Inspect Full Diff</span>
          </button>
        )}
      </div>
    </FlatCard>
  );
}
