import { isBotRunActive, summarizeBotRun } from "../botRun.js";
import { useBotRun, useNow } from "../hooks/useBotRun.js";
import { Icon } from "./Icon.js";

/**
 * One-line status of the current pipeline run, docked above the composer. The
 * detail (per-stage state, logs, merge) lives in the Bot Flow tab; clicking the
 * strip opens it.
 */
export function BotRunStrip({ onOpen }: { onOpen: () => void }) {
  const { run, abort, dismiss } = useBotRun();
  const active = run !== null && isBotRunActive(run.status);
  const now = useNow(active);
  if (!run) return null;

  const summary = summarizeBotRun(run, now);
  return (
    <div className="chat-column__tasks">
      <div className={`bot-run-strip bot-run-strip--${run.status}`} role="status">
        <span className="bot-run-strip__dot" aria-hidden />
        <button type="button" className="bot-run-strip__main" onClick={onOpen} title="Open the pipeline monitor">
          <span className="bot-run-strip__name">{run.workflowName}</span>
          <span className="bot-run-strip__detail">{summary.detail}</span>
        </button>
        <span className="bot-run-strip__time">{summary.elapsed}</span>
        {active ? (
          <button type="button" className="bot-run-strip__action" onClick={() => void abort()} title="Stop the pipeline" aria-label="Stop the pipeline">
            <Icon name="close" size={13} />
          </button>
        ) : (
          <button type="button" className="bot-run-strip__action" onClick={dismiss} title="Dismiss" aria-label="Dismiss">
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
