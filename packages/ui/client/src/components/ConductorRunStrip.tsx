import { isConductorRunActive, summarizeConductorRun } from "../conductorRun.js";
import { useConductorRun, useNow } from "../hooks/useConductorRun.js";
import { Icon } from "./Icon.js";

/**
 * One-line status of the current pipeline run, docked above the composer. The
 * detail (per-stage state, logs, merge) lives in the Pipeline tab; clicking the
 * strip opens it.
 */
export function ConductorRunStrip({ onOpen }: { onOpen: () => void }) {
  const { run, abort, dismiss } = useConductorRun();
  const active = run !== null && isConductorRunActive(run.status);
  const now = useNow(active);
  if (!run) return null;

  const summary = summarizeConductorRun(run, now);
  return (
    <div className="chat-column__tasks">
      <div className={`conductor-run-strip conductor-run-strip--${run.status}`} role="status">
        <span className="conductor-run-strip__dot" aria-hidden />
        <button type="button" className="conductor-run-strip__main" onClick={onOpen} title="Open the pipeline monitor">
          <span className="conductor-run-strip__name">{run.workflowName}</span>
          <span className="conductor-run-strip__detail">{summary.detail}</span>
        </button>
        <span className="conductor-run-strip__time">{summary.elapsed}</span>
        {active ? (
          <button type="button" className="conductor-run-strip__action" onClick={() => void abort()} title="Stop the pipeline" aria-label="Stop the pipeline">
            <Icon name="close" size={13} />
          </button>
        ) : (
          <button type="button" className="conductor-run-strip__action" onClick={dismiss} title="Dismiss" aria-label="Dismiss">
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
