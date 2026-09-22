import { useEffect, useRef, useState } from "react";
import type {
  BotStageProgress,
  BotWorkflowDefinition,
} from "@deyin/contract";
import { Icon } from "./Icon.js";

function formatSeconds(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export interface BotFlowPanelProps {
  workspaceRoot?: string | null;
  onOpenWorkflows?: (workflowId?: string | null) => void;
}

export function BotFlowPanel({ workspaceRoot, onOpenWorkflows }: BotFlowPanelProps) {
  const [workflows, setWorkflows] = useState<BotWorkflowDefinition[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  // Active run state
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "stalled" | "completed" | "failed" | "aborted">("idle");
  const [activeStages, setActiveStages] = useState<BotStageProgress[]>([]);
  const [totalElapsed, setTotalElapsed] = useState(0);

  // Live terminal logs
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const loadWorkflows = async () => {
    if (window.deyin?.botWorkflows) {
      try {
        const list = await window.deyin.botWorkflows.list();
        setWorkflows(list);
        if (list.length > 0 && !selectedWorkflowId) {
          setSelectedWorkflowId(list[0]!.id);
        }
      } catch {}
    }
  };

  useEffect(() => {
    loadWorkflows();

    // Listen to live bot workflow events from host
    if (window.deyin?.botWorkflows?.onEvent) {
      const unsub = window.deyin.botWorkflows.onEvent((event: any) => {
        if (event.type === "workflow:started") {
          setActiveRunId(event.runId);
          setRunStatus("running");
          if (event.state?.stages) setActiveStages(event.state.stages);
        } else if (event.type === "stage:started" || event.type === "stage:heartbeat" || event.type === "stage:completed" || event.type === "stage:stalled") {
          if (event.progress) {
            setActiveStages((prev) => {
              const copy = [...prev];
              const idx = copy.findIndex((s) => s.stageId === event.progress.stageId);
              if (idx >= 0) copy[idx] = event.progress;
              else copy.push(event.progress);
              return copy;
            });
          }
          if (event.type === "stage:stalled") {
            setRunStatus("stalled");
          } else if (event.type === "stage:heartbeat") {
            setRunStatus((prev) => (prev === "stalled" ? "running" : prev));
          }
        } else if (event.type === "workflow:completed" || event.type === "workflow:aborted") {
          if (event.type === "workflow:aborted" || event.state?.status === "aborted") {
            setRunStatus("aborted");
          } else if (event.state?.status === "completed") {
            setRunStatus("completed");
          } else {
            setRunStatus("failed");
          }
        }
      });
      return unsub;
    }
  }, []);

  // Poll terminal logs while running or stalled
  useEffect(() => {
    if (!activeRunId || (runStatus !== "running" && runStatus !== "stalled")) return;
    const interval = setInterval(async () => {
      if (window.deyin?.externalAgents) {
        try {
          const lines = await window.deyin.externalAgents.logs(activeRunId, 200);
          setLogs(lines);
          logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
        } catch {}
      }
      setTotalElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [activeRunId, runStatus]);

  const selectedWorkflow = workflows.find((w) => w.id === selectedWorkflowId);

  const handleRunWorkflow = async () => {
    if (!selectedWorkflowId || !window.deyin?.botWorkflows) return;
    setRunStatus("running");
    setLogs([]);
    setTotalElapsed(0);
    try {
      const res = await window.deyin.botWorkflows.run(selectedWorkflowId, workspaceRoot ?? "");
      if (res?.runId) setActiveRunId(res.runId);
    } catch (err: any) {
      setRunStatus("failed");
      setLogs([`Failed to start: ${err.message}`]);
    }
  };

  const handleAbort = async () => {
    if (activeRunId && window.deyin?.botWorkflows) {
      await window.deyin.botWorkflows.abort(activeRunId);
      setRunStatus("aborted");
    }
  };

  const handleNudge = async () => {
    if (activeRunId && window.deyin?.externalAgents) {
      await window.deyin.externalAgents.nudge(activeRunId, "Ping: status check requested by user.");
    }
  };

  return (
    <div className="bot-flow-panel">
      {/* Top Controls Bar */}
      <div className="bot-flow-panel__top">
        <div className="bot-flow-panel__workflow-select-row">
          <select
            className="bot-flow-panel__select"
            value={selectedWorkflowId ?? ""}
            onChange={(e) => setSelectedWorkflowId(e.target.value)}
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.stages.length} stages)
              </option>
            ))}
            {workflows.length === 0 && <option value="">No workflows configured</option>}
          </select>

          {selectedWorkflow && onOpenWorkflows && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => onOpenWorkflows(selectedWorkflow.id)}
              title="Edit workflow in Workflows editor"
            >
              <Icon name="edit" size={13} />
            </button>
          )}
        </div>

        {selectedWorkflow && (
          <div className="bot-flow-panel__run-bar">
            <button
              type="button"
              className={`btn ${runStatus === "running" || runStatus === "stalled" ? "btn--danger" : "btn--primary"} btn--sm`}
              onClick={runStatus === "running" || runStatus === "stalled" ? handleAbort : handleRunWorkflow}
            >
              <Icon name={runStatus === "running" || runStatus === "stalled" ? "close" : "bolt"} size={12} />
              <span>{runStatus === "running" || runStatus === "stalled" ? "Abort Pipeline" : "Execute Pipeline"}</span>
            </button>

            {(runStatus === "running" || runStatus === "stalled") && (
              <button type="button" className="btn btn--subtle btn--sm" onClick={handleNudge}>
                <Icon name="message" size={12} />
                <span>Nudge Bot</span>
              </button>
            )}

            <span className="bot-flow-panel__status-pill">
              Status: <strong>{runStatus}</strong>
              {(runStatus === "running" || runStatus === "stalled") && ` · ${formatSeconds(totalElapsed)}`}
            </span>
          </div>
        )}
      </div>

      {/* Main Content Area */}
      <div className="bot-flow-panel__content">
        {/* Stages Timeline */}
        <div className="bot-flow-panel__stages-section">
          <div className="bot-flow-panel__section-title">
            Pipeline Stages
            {selectedWorkflow ? ` (${selectedWorkflow.stages.length})` : ""}
          </div>

          <div className="bot-flow-panel__stepper">
            {selectedWorkflow?.stages.map((stage, idx) => {
              const liveStage = activeStages.find((s) => s.stageId === stage.id);
              const isCurrent = liveStage?.status === "running";
              const isDone = liveStage?.status === "completed";
              const isStalled = liveStage?.status === "stalled";
              const isFailed = liveStage?.status === "failed";

              return (
                <div
                  key={stage.id}
                  className={`bot-flow-panel__step-card ${isCurrent ? "bot-flow-panel__step-card--current" : ""} ${
                    isDone ? "bot-flow-panel__step-card--done" : ""
                  } ${isStalled ? "bot-flow-panel__step-card--stalled" : ""} ${isFailed ? "bot-flow-panel__step-card--failed" : ""}`}
                >
                  <div className="bot-flow-panel__step-header">
                    <span className="bot-flow-panel__step-idx">{idx + 1}</span>
                    <span className="bot-flow-panel__step-name">{stage.name}</span>
                    <span className="bot-flow-panel__step-agent-pill">
                      <Icon name="cpu" size={11} />
                      {stage.agentId}
                    </span>
                  </div>

                  <div className="bot-flow-panel__step-meta">
                    {stage.modelOverride && (
                      <span className="bot-flow-panel__step-model">Model: {stage.modelOverride}</span>
                    )}
                    {stage.worktree?.isolate !== false && (
                      <span className="bot-flow-panel__step-worktree" title="Runs in isolated Git Worktree">
                        <Icon name="gitBranch" size={10} />
                        Worktree
                      </span>
                    )}
                    {liveStage && (
                      <span className="bot-flow-panel__step-timer">
                        {formatSeconds(Math.round(liveStage.elapsedMs / 1000))}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {selectedWorkflow && activeStages.some((s) => s.branchName && (s.status === "completed" || runStatus === "completed")) && (
              <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                {(() => {
                  const lastBranch = [...activeStages].reverse().find((s) => s.branchName)?.branchName;
                  if (!lastBranch) return null;
                  return (
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      onClick={async () => {
                        if (window.deyin?.botWorkflows?.merge) {
                          const res = await window.deyin.botWorkflows.merge(workspaceRoot ?? "", lastBranch);
                          alert(res.message);
                        }
                      }}
                    >
                      <Icon name="gitMerge" size={12} />
                      <span>1-Click Merge {lastBranch}</span>
                    </button>
                  );
                })()}
              </div>
            )}

            {!selectedWorkflow && (
              <div className="bot-flow-panel__empty">
                <Icon name="bot" size={32} />
                <p>No workflow selected. Configure pipelines in Workflows.</p>
              </div>
            )}
          </div>
        </div>

        {/* Live Terminal Console Streamer */}
        <div className="bot-flow-panel__terminal-section">
          <div className="bot-flow-panel__section-title">
            <span>Terminal Log Streamer</span>
            <span className="bot-flow-panel__log-count">{logs.length} lines</span>
          </div>

          <div className="bot-flow-panel__terminal-box">
            {logs.length > 0 ? (
              logs.map((line, i) => (
                <div key={i} className="bot-flow-panel__log-line">
                  {line}
                </div>
              ))
            ) : (
              <div className="bot-flow-panel__log-placeholder">
                Waiting for execution logs…
              </div>
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
