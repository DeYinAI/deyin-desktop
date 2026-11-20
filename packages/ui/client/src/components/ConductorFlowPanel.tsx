import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConductorStageProgress, ConductorWorkflowDefinition } from "@deyin/contract";
import { currentStageIndex, formatClock, isConductorRunActive, summarizeConductorRun } from "../conductorRun.js";
import { useConductorRun, useConductorRunLogs, useNow } from "../hooks/useConductorRun.js";
import { useConfirm } from "./ConfirmDialog.js";
import { Icon } from "./Icon.js";

export interface ConductorFlowPanelProps {
  workspaceRoot?: string | null;
  /** False while the panel's tab is in the background: logs are only polled when it is on screen. */
  visible?: boolean;
  onOpenWorkflows?: (workflowId?: string | null) => void;
}

type StageStatus = ConductorStageProgress["status"];

interface StageRowModel {
  id: string;
  name: string;
  agentId: string;
  model?: string;
  isolated: boolean;
  progress?: ConductorStageProgress;
}

/** Live and broken stages open themselves; settled and waiting ones stay a single line. */
function opensByDefault(status: StageStatus): boolean {
  return status === "running" || status === "stalled" || status === "failed";
}

function stageStatusLabel(status: StageStatus): string {
  switch (status) {
    case "queued":
      return "Waiting";
    case "running":
      return "Running";
    case "stalled":
      return "Not responding";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "aborted":
      return "Stopped";
    default: {
      const unhandled: never = status;
      throw new Error(`Unhandled stage status: ${String(unhandled)}`);
    }
  }
}

/** The tail of the current stage's output, pinned to the newest line. */
function StageLog({ lines }: { lines: string[] }) {
  const boxRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines]);
  return (
    <pre className="conductor-flow__log" ref={boxRef} tabIndex={0} aria-label="Stage output">
      {lines.slice(-80).join("\n")}
    </pre>
  );
}

function StageRow({
  row,
  open,
  now,
  logs,
  onToggle,
}: {
  row: StageRowModel;
  open: boolean;
  now: number;
  /** Output to show inside this row; only the run's current stage gets it. */
  logs: string[] | null;
  onToggle: () => void;
}) {
  const progress = row.progress;
  const status: StageStatus = progress?.status ?? "queued";
  const live = status === "running" || status === "stalled";
  const elapsedMs = live && progress?.startedAt !== undefined ? now - progress.startedAt : (progress?.elapsedMs ?? 0);
  const showTime = progress !== undefined && status !== "queued";

  return (
    <div className={`conductor-flow__stage conductor-flow__stage--${status}`}>
      <button type="button" className="conductor-flow__stage-head" aria-expanded={open} onClick={onToggle}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <span className="conductor-flow__stage-dot" aria-hidden />
        <span className="conductor-flow__stage-name">{row.name}</span>
        <span className="conductor-flow__stage-agent">{row.agentId}</span>
        {showTime && <span className="conductor-flow__stage-time">{formatClock(elapsedMs)}</span>}
      </button>
      {open && (
        <div className="conductor-flow__stage-body">
          <div className="conductor-flow__stage-meta">
            <span>{stageStatusLabel(status)}</span>
            {row.model && <span>{row.model}</span>}
            {progress?.branchName ? (
              <span className="conductor-flow__stage-branch" title="Isolated git worktree branch">
                <Icon name="gitBranch" size={11} />
                {progress.branchName}
              </span>
            ) : (
              row.isolated && (
                <span className="conductor-flow__stage-branch" title="Runs in an isolated git worktree">
                  <Icon name="gitBranch" size={11} />
                  worktree
                </span>
              )
            )}
          </div>
          {progress?.error && <p className="conductor-flow__stage-error">{progress.error}</p>}
          {progress?.outputSummary && <p className="conductor-flow__stage-summary">{progress.outputSummary}</p>}
          {logs !== null && logs.length > 0 && <StageLog lines={logs} />}
        </div>
      )}
    </div>
  );
}

export function ConductorFlowPanel({ workspaceRoot, visible = true, onOpenWorkflows }: ConductorFlowPanelProps) {
  const { confirm } = useConfirm();
  const { run, start, abort, nudge } = useConductorRun();

  const [workflows, setWorkflows] = useState<ConductorWorkflowDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Rows the user opened or closed by hand; everything else follows `opensByDefault`. */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [startError, setStartError] = useState<string | null>(null);
  const [mergeNote, setMergeNote] = useState<{ ok: boolean; text: string } | null>(null);

  const loadWorkflows = useCallback(async () => {
    if (!window.deyin?.conductorWorkflows) return;
    try {
      const list = await window.deyin.conductorWorkflows.list();
      setWorkflows(list);
      setSelectedId((current) => current ?? list[0]?.id ?? null);
    } catch {
      // No workflow list available yet; the panel shows its empty state.
    }
  }, []);

  // Pipelines can be written by the agent while this tab is closed, so refresh whenever it is shown.
  useEffect(() => {
    if (visible) void loadWorkflows();
  }, [visible, workspaceRoot, loadWorkflows]);

  // Follow every new run, whoever started it, and start its rows from their defaults.
  const runId = run?.runId ?? null;
  const runWorkflowId = run?.workflowId ?? null;
  useEffect(() => {
    if (!runId || !runWorkflowId) return;
    setSelectedId(runWorkflowId);
    setToggled({});
    setStartError(null);
    setMergeNote(null);
    void loadWorkflows();
  }, [runId, runWorkflowId, loadWorkflows]);

  const active = run !== null && isConductorRunActive(run.status);
  // While a run is live the panel shows that run's pipeline, whatever the picker says.
  const viewedId = active && run ? run.workflowId : (selectedId ?? workflows[0]?.id ?? null);
  const selected = workflows.find((w) => w.id === viewedId);
  const liveRun = run !== null && run.workflowId === viewedId ? run : null;
  const title = selected?.name ?? liveRun?.workflowName ?? null;

  const rows = useMemo<StageRowModel[]>(() => {
    if (selected) {
      return selected.stages.map((def) => ({
        id: def.id,
        name: def.name,
        agentId: def.agentId,
        model: def.modelOverride,
        isolated: def.worktree?.isolate !== false,
        progress: liveRun?.stages.find((s) => s.stageId === def.id),
      }));
    }
    return (liveRun?.stages ?? []).map((progress) => ({
      id: progress.stageId,
      name: progress.stageName,
      agentId: progress.agentId,
      isolated: progress.worktreePath !== undefined,
      progress,
    }));
  }, [selected, liveRun]);

  const now = useNow(active);
  const logs = useConductorRunLogs(liveRun?.runId ?? null, active, visible);
  const focusIndex = liveRun ? currentStageIndex(liveRun) : -1;

  const mergeBranch = useMemo(() => {
    if (!liveRun) return null;
    const settled = liveRun.status === "completed" || liveRun.stages.some((s) => s.status === "completed");
    if (!settled) return null;
    return [...liveRun.stages].reverse().find((s) => s.branchName)?.branchName ?? null;
  }, [liveRun]);

  const handleRun = async () => {
    if (!selected) return;
    setStartError(null);
    setMergeNote(null);
    const res = await start(selected.id, workspaceRoot ?? "");
    if (!res.ok) setStartError(res.error);
  };

  const handleMerge = async () => {
    if (!mergeBranch || !window.deyin?.conductorWorkflows?.merge) return;
    const accepted = await confirm({
      title: "Merge pipeline branch",
      message: `Merge ${mergeBranch} into the current branch of this workspace?`,
      confirmLabel: "Merge",
    });
    if (!accepted) return;
    const res = await window.deyin.conductorWorkflows.merge(workspaceRoot ?? "", mergeBranch);
    setMergeNote({ ok: res.ok, text: res.message });
  };

  if (workflows.length === 0 && !liveRun) {
    return (
      <div className="conductor-flow">
        <div className="conductor-flow__empty">
          <Icon name="bot" size={28} />
          <p className="conductor-flow__empty-title">No pipelines yet</p>
          <p>
            Describe what you want in the chat, or type <kbd>/pipeline</kbd> for a guided setup.
          </p>
          {onOpenWorkflows && (
            <button type="button" className="btn btn--subtle btn--sm" onClick={() => onOpenWorkflows(null)}>
              Open the editor
            </button>
          )}
        </div>
      </div>
    );
  }

  const summary = liveRun ? summarizeConductorRun(liveRun, now) : null;

  return (
    <div className="conductor-flow">
      <div className="conductor-flow__top">
        {selected || workflows.length > 1 ? (
          <select
            className="conductor-flow__select"
            value={viewedId ?? ""}
            disabled={active}
            aria-label="Pipeline"
            onChange={(e) => {
              setSelectedId(e.target.value);
              setToggled({});
            }}
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.stages.length} stages)
              </option>
            ))}
          </select>
        ) : (
          <span className="conductor-flow__title">{title}</span>
        )}
        {selected && onOpenWorkflows && (
          <button type="button" className="icon-btn" onClick={() => onOpenWorkflows(selected.id)} title="Edit this pipeline" aria-label="Edit this pipeline">
            <Icon name="edit" size={13} />
          </button>
        )}
        {active ? (
          <button type="button" className="btn btn--danger btn--sm" onClick={() => void abort()}>
            Stop
          </button>
        ) : (
          selected && (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void handleRun()}>
              <Icon name="bolt" size={12} />
              <span>{liveRun ? "Run again" : "Run"}</span>
            </button>
          )
        )}
      </div>

      {liveRun && summary && (
        <div className={`conductor-flow__run conductor-flow__run--${liveRun.status}`} role="status">
          <span className="conductor-flow__run-dot" aria-hidden />
          <span className="conductor-flow__run-detail">{summary.detail}</span>
          <span className="conductor-flow__run-time">{summary.elapsed}</span>
          {active && (
            <button type="button" className="btn btn--subtle btn--sm" onClick={() => void nudge()} title="Ask the running agent for a status update">
              Nudge
            </button>
          )}
        </div>
      )}
      {startError && <p className="conductor-flow__note conductor-flow__note--error">{startError}</p>}

      <div className="conductor-flow__stages">
        {rows.map((row, index) => {
          const status: StageStatus = row.progress?.status ?? "queued";
          return (
            <StageRow
              key={row.id}
              row={row}
              open={toggled[row.id] ?? opensByDefault(status)}
              now={now}
              logs={index === focusIndex ? logs : null}
              onToggle={() => setToggled((cur) => ({ ...cur, [row.id]: !(cur[row.id] ?? opensByDefault(status)) }))}
            />
          );
        })}
      </div>

      {mergeBranch && (
        <div className="conductor-flow__merge">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void handleMerge()}>
            <Icon name="gitMerge" size={12} />
            <span>Merge {mergeBranch}</span>
          </button>
          {mergeNote && (
            <p className={`conductor-flow__note${mergeNote.ok ? "" : " conductor-flow__note--error"}`}>{mergeNote.text}</p>
          )}
        </div>
      )}
    </div>
  );
}
