import { useEffect, useState } from "react";
import type { ModelInfo } from "@deyin/contract";
import { Icon } from "../Icon.js";
import { MenuSelect } from "../MenuSelect.js";
import { Callout } from "../ui/index.js";
import { EmptyState, Segmented } from "../settings/controls.js";
import { ActivityTab } from "./ActivityTab.js";
import { overallState, runStateOf, runStateOptions, withRunState, type RunState } from "./model.js";
import { SettingsTab } from "./SettingsTab.js";
import { useSuperagent } from "./useSuperagent.js";

type Tab = "activity" | "settings";


/** A clock for relative times that moves while the page is open. */
function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}

/** Superagent: a proactive coding agent for one GitHub repository. Switched on here, steered by its tickets and settings. */
export function SuperagentPage(props: { models: ModelInfo[]; selectedProviderId: string; onBack: () => void }) {
  const controller = useSuperagent();
  const { view } = controller;
  const [tab, setTab] = useState<Tab>("activity");
  const now = useNow(30_000);
  const api = window.deyin.superagent;

  // Until the first look at the setup, the settings are where a person needs to be.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    if (view && !placed) {
      setPlaced(true);
      if (!view.status.ready) setTab("settings");
    }
  }, [view, placed]);

  if (!api || controller.unavailable) {
    return (
      <div className="superagent superagent--empty">
        <EmptyState icon="rocket" title="Superagent" hint={controller.unavailable ?? "Superagent runs in the desktop app."} />
      </div>
    );
  }
  if (!view) {
    return (
      <div className="superagent superagent--empty">
        <EmptyState icon="rocket" title="Superagent" hint="Loading…" />
      </div>
    );
  }

  const state = overallState(view.status);
  const runState = runStateOf(view.settings);
  const setRunState = (next: RunState) => void controller.act(() => api.saveSettings(withRunState(view.settings, next), view.settingsRevision));
  // Until the setup is complete it cannot be switched on; turning it off is always possible.
  const canRun = view.status.ready || view.settings.enabled;
  // The mode (Active, Observing, Mentions only) is only news while it is running; Off, Paused and Needs setup are said by the control and the callouts.
  const mode = state.tone === "ok" ? state.label : null;
  const working = view.status.workers.running + (view.status.orchestrator.running ? 1 : 0);

  return (
    <div className="superagent">
      <header className="superagent__head">
        <button type="button" className="icon-btn icon-btn--small" title="Back" aria-label="Back" onClick={props.onBack}>
          <Icon name="arrowLeft" size={14} />
        </button>
        <div className="superagent__head-text">
          <h1 className="superagent__title">Superagent</h1>
          <div className="superagent__meta">
            {view.status.repository ? `Watching ${view.status.repository}` : "No repository yet"}
            {view.status.account ? ` as @${view.status.account.login}` : ""}
            {mode ? ` · ${mode}` : ""}
            {working > 0 ? ` · ${working} working` : ""}
          </div>
        </div>
        <MenuSelect
          label="Superagent state"
          className={`superagent__state superagent__state--${runState}`}
          align="end"
          value={runState}
          options={runStateOptions(canRun)}
          disabled={controller.busy}
          onChange={setRunState}
        />
      </header>

      <div className="superagent__tabs">
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { id: "activity", label: "Activity" },
            { id: "settings", label: view.status.ready ? "Settings" : "Set up" },
          ]}
        />
      </div>

      <div className="superagent__body">
        {controller.error && (
          <Callout tone="bad">
            {controller.error}{" "}
            <button type="button" className="btn btn--ghost btn--small" onClick={controller.clearError}>
              Dismiss
            </button>
          </Callout>
        )}
        {!view.status.ready && (
          <Callout tone="warn">
            <strong>Superagent is not ready yet.</strong>
            <ul className="superagent__gaps">
              {view.status.gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </Callout>
        )}
        {view.status.poll.error && <Callout tone="bad">GitHub could not be read: {view.status.poll.error}</Callout>}
        {view.status.storeError && <Callout tone="bad">Superagent could not save its state: {view.status.storeError}</Callout>}
        {view.settings.enabled && view.status.mode === "observe" && tab === "activity" && (
          <Callout tone="muted">Observing: messages that do not address the agent are assessed and recorded as what it would take on, but not acted on. Switch the mode to Auto in Settings to let the agent act on them.</Callout>
        )}
        {tab === "activity" ? (
          <ActivityTab view={view} controller={controller} now={now} />
        ) : (
          <SettingsTab view={view} controller={controller} models={props.models} providerId={props.selectedProviderId} />
        )}
      </div>
    </div>
  );
}
