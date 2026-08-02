import { useEffect, useState } from "react";
import type { DeyinSettings, ModelInfo, Advanced agentMetricsSnapshot } from "../../../shared/types.js";
import { HelpTooltip } from "../HelpTooltip.js";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import { Advanced agentDevTools } from "./Advanced agentDevTools.js";

interface Props {
  settings: DeyinSettings;
  liveModels: ModelInfo[];
  activeThreadId?: string | null;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

export function CoordinatorSettings({ settings, liveModels, activeThreadId, onChange }: Props) {
  const [metrics, setMetrics] = useState<Advanced agentMetricsSnapshot | null>(null);

  useEffect(() => {
    void window.deyin.agent?.metrics().then(setMetrics).catch(() => setMetrics(null));
  }, []);

  const plannerOptions = liveModels.map((m) => m.id);
  const executorHint = settings.defaultModel?.split("::")[1] ?? "executor model";

  return (
    <div className="settings-page">
      <PageHeader
        title="Planner coordinator"
        description="Two-model coordination: a read-only planner researches and hands off to the executor. Separate sessions preserve prefix cache stability."
      />

      <SectionTitle>Enable</SectionTitle>
      <SettingCard
        title="Coordinator"
        description="Route complex tasks through planner → executor. Requires a planner model different from the executor."
      >
        <Toggle checked={settings.enableCoordinator} onChange={(enableCoordinator) => onChange({ enableCoordinator })} />
      </SettingCard>

      <SectionTitle>Planner model</SectionTitle>
      <SettingCard
        title="Planner model"
        description={`Must differ from ${executorHint}. DeepSeek-Chat or a fast research model works well.`}
      >
        <select
          className="select"
          value={settings.plannerModel ?? ""}
          disabled={!settings.enableCoordinator}
          onChange={(e) => onChange({ plannerModel: e.target.value || null })}
        >
          <option value="">None (coordinator disabled)</option>
          {plannerOptions.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </SettingCard>

      <SectionTitle>Routing</SectionTitle>
      <SettingCard
        title={
          <>
            Routing policy
            <HelpTooltip text="Conservative plans less often. Aggressive routes more multi-file work through the planner." />
          </>
        }
        description="Deterministic rules — no classifier model."
      >
        <select
          className="select"
          value={settings.coordinatorRoutingPolicy}
          disabled={!settings.enableCoordinator}
          onChange={(e) =>
            onChange({
              coordinatorRoutingPolicy: e.target.value as DeyinSettings["coordinatorRoutingPolicy"],
            })
          }
        >
          <option value="balanced">Balanced (default)</option>
          <option value="conservative">Conservative — planner for high-risk only</option>
          <option value="aggressive">Aggressive — planner for most non-trivial edits</option>
        </select>
      </SettingCard>

      {metrics && settings.enableCoordinator && (
        <>
          <SectionTitle>Usage this week</SectionTitle>
          <SettingCard title="Coordinator runs" description="Total routed turns.">
            <span className="hint">{metrics.coordinator.runs}</span>
          </SettingCard>
          <SettingCard title="Planner invocations" description="Times the planner model ran.">
            <span className="hint">{metrics.coordinator.plannerInvocations}</span>
          </SettingCard>
          <SettingCard title="Fallbacks" description="Planner failures that fell back to executor-only.">
            <span className="hint">{metrics.coordinator.fallbacks}</span>
          </SettingCard>
        </>
      )}

      <Advanced agentDevTools threadId={activeThreadId} title="Coordinator decision log" />
    </div>
  );
}
