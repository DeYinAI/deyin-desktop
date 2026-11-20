import { useState } from "react";
import type { AutomationInfo } from "@deyin/contract";
import { useT } from "../i18n.js";
import { healingView, type RevisionView } from "../automationHealing.js";
import { Toggle } from "./settings/controls.js";

interface Props {
  task: AutomationInfo;
  /** Turn automatic patching on or off; rejects with the reason it was refused. */
  onSetAutoHeal: (task: AutomationInfo, enabled: boolean) => Promise<void>;
  /** Undo a patch and every later one; rejects with the reason it was refused. */
  onRevert: (task: AutomationInfo, revisionId: string) => Promise<void>;
}

/**
 * What self-healing has learned for one automation, and the means to switch it off or undo a patch.
 * The patches themselves are made by the healer after a failed run; nothing here edits a rule.
 */
export function AutomationHealing({ task, onSetAutoHeal, onRevert }: Props) {
  const t = useT();
  const view = healingView(task);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="autos-editor__field autos-healing" aria-labelledby={`healing-${task.id}`}>
      <div className="autos-healing__head">
        <h3 id={`healing-${task.id}`}>{t("automations.healing.title")}</h3>
        <Toggle
          checked={view.enabled}
          disabled={busy}
          label={t("automations.healing.switch")}
          onChange={(enabled) => void attempt(() => onSetAutoHeal(task, enabled))}
        />
      </div>
      <p className="autos-detail__notice">{t("automations.healing.description")}</p>

      {view.rules.length > 0 && (
        <>
          <h4 className="autos-healing__label">{t("automations.healing.rules")}</h4>
          <ul className="autos-healing__rules">
            {view.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </>
      )}

      {view.revisions.length > 0 && (
        <>
          <h4 className="autos-healing__label">{t("automations.healing.history")}</h4>
          <ul className="autos-healing__revisions">
            {view.revisions.map((revision) => (
              <li key={revision.id} className="autos-healing__revision">
                <RevisionRow
                  revision={revision}
                  busy={busy}
                  onRevert={() => void attempt(() => onRevert(task, revision.id))}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {error && (
        <p className="autos-detail__failure" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function RevisionRow({ revision, busy, onRevert }: { revision: RevisionView; busy: boolean; onRevert: () => void }) {
  const t = useT();
  return (
    <>
      <div className="autos-healing__revision-head">
        <time>{new Date(revision.at).toLocaleString()}</time>
        <span className="autos-healing__status">{t(revision.statusKey)}</span>
        {revision.canRevert && (
          <button
            type="button"
            className="autos-detail__link autos-healing__revert"
            disabled={busy}
            title={t("automations.healing.revertHint")}
            onClick={onRevert}
          >
            {t("automations.healing.revert")}
          </button>
        )}
      </div>
      <p className="autos-healing__why">{revision.rationale}</p>
      {revision.added.map((rule) => (
        <p key={`+${rule}`} className="autos-healing__change autos-healing__change--added">
          <span className="autos-healing__change-kind">{t("automations.healing.added")}</span> {rule}
        </p>
      ))}
      {revision.removed.map((rule) => (
        <p key={`-${rule}`} className="autos-healing__change autos-healing__change--removed">
          <span className="autos-healing__change-kind">{t("automations.healing.removed")}</span> {rule}
        </p>
      ))}
      {revision.note && <p className="autos-detail__notice">{revision.note}</p>}
    </>
  );
}
