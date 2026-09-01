import { useT } from "../i18n.js";
import { Icon } from "./Icon.js";

interface ComposerPendingBarsProps {
 /** Follow-up queued while a run is active. */
 queued?: string | null;
 /** Draft shown as a steer bar while the agent runs (Cursor-style Steer). */
 steer?: string | null;
 /** Abort current run and send immediately (Cursor-like interrupt). */
 onSendNow?: () => void;
 /** Run the queued message in a new thread without stopping the current run. */
 onStartMultitasking?: () => void;
 /** Drop the queued follow-up. */
 onClearQueue?: () => void;
 /** Queue the draft as follow-up without stopping the run (Cursor Steer). */
 onSteer?: () => void;
 /** Discard the steer draft. */
 onDismissSteer?: () => void;
}

/**
 * Cursor-style pending bars that float ABOVE the workspace (folder) bar and
 * the composer pod: the queued follow-up and the live Steer preview. Extracted
 * from the composer card so they stack above it, matching Cursor's layout.
 */
export function ComposerPendingBars(props: ComposerPendingBarsProps) {
 const t = useT();
 const queued = props.queued?.trim() ?? "";
 const steer = props.steer?.trim() ?? "";
 if (queued.length === 0 && steer.length === 0) return null;
 return (
 <div className="composer-pending-stack">
 {queued.length > 0 && (
 <div className="composer__pending composer__pending--queued">
 <div className="composer__pending-header">
 <span className="composer__pending-label">{t("composer.queuedMessage")}</span>
 <div className="composer__pending-actions">
 {props.onStartMultitasking && (
 <button
 type="button"
 className="composer__pending-link"
 title={t("composer.startMultitaskingHint")}
 onClick={() => props.onStartMultitasking?.()}
 >
 {t("composer.startMultitasking")}
 </button>
 )}
 {props.onSendNow && (
 <button
 type="button"
 className="composer__pending-link"
 title={t("composer.sendNowHint")}
 onClick={() => props.onSendNow?.()}
 >
 {t("composer.sendNow")}
 </button>
 )}
 {props.onClearQueue && (
 <button
 type="button"
 className="composer__pending-dismiss"
 title={t("composer.removeQueuedHint")}
 aria-label={t("composer.removeQueuedHint")}
 onClick={() => props.onClearQueue?.()}
 >
 <Icon name="close" size={12} />
 </button>
 )}
 </div>
 </div>
 <div className="composer__pending-body" title={queued}>
 <span className="composer__pending-text composer__pending-text--preview">{queued}</span>
 </div>
 </div>
 )}
 {steer.length > 0 && (
 <div className="composer__pending composer__pending--steer" title={steer}>
 <Icon name="steer" size={14} className="composer__pending-steer-icon" />
 <span className="composer__pending-text composer__pending-text--quoted">&ldquo;{steer}&rdquo;</span>
 <div className="composer__pending-actions">
 <button
 type="button"
 className="composer__pending-steer"
 title="Queue as follow-up without stopping the run"
 onClick={() => props.onSteer?.()}
 >
 <Icon name="steer" size={12} />
 Steer
 </button>
 <button
 type="button"
 className="composer__pending-dismiss"
 title="Discard draft"
 aria-label="Discard draft"
 onClick={() => props.onDismissSteer?.()}
 >
 <Icon name="trash" size={12} />
 </button>
 </div>
 </div>
 )}
 </div>
 );
}
