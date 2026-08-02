import { useEffect, useState } from "react";
import type { DeyinSettings, ReasonixMetricsSnapshot } from "../../../shared/types.js";
import { HelpTooltip } from "../HelpTooltip.js";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import { ReasonixDevTools } from "./ReasonixDevTools.js";

interface Props {
  settings: DeyinSettings;
  activeThreadId?: string | null;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

export function SchedulerSettings({ settings, activeThreadId, onChange }: Props) {
  const [metrics, setMetrics] = useState<ReasonixMetricsSnapshot | null>(null);

  useEffect(() => {
    void window.deyin.reasonix?.metrics().then(setMetrics).catch(() => setMetrics(null));
  }, []);

  return (
    <div className="settings-page">
      <PageHeader
        title="Fleet & scheduler"
        description="Session-wide concurrency for subagents, fleet parallel writes, and background jobs."
      />

      <SectionTitle>Feature flags</SectionTitle>
      <SettingCard
        title="Fleet orchestration"
        description="Expose fleet and parallel_tasks tools for coordinated multi-agent work."
      >
        <Toggle checked={settings.enableFleet} onChange={(enableFleet) => onChange({ enableFleet })} />
      </SettingCard>

      <SectionTitle>Concurrency</SectionTitle>
      <SettingCard
        title={`Max subagent concurrency (${settings.maxSubagentConcurrency})`}
        description="Total parallel task/fleet slots per session."
      >
        <input
          type="range"
          min={1}
          max={32}
          step={1}
          value={settings.maxSubagentConcurrency}
          onChange={(e) => {
            const maxSubagentConcurrency = Number(e.target.value);
            onChange({
              maxSubagentConcurrency,
              maxParallelWriters: Math.min(settings.maxParallelWriters, maxSubagentConcurrency),
            });
          }}
        />
      </SettingCard>
      <SettingCard
        title={`Max parallel writers (${settings.maxParallelWriters})`}
        description="Concurrent writers with non-overlapping write_paths."
      >
        <input
          type="range"
          min={1}
          max={settings.maxSubagentConcurrency}
          step={1}
          value={settings.maxParallelWriters}
          onChange={(e) => onChange({ maxParallelWriters: Number(e.target.value) })}
        />
      </SettingCard>

      <SectionTitle>Write-path validation</SectionTitle>
      <SettingCard
        title={
          <>
            Preflight write_paths
            <HelpTooltip text="When enabled, fleet rejects overlapping write_paths before any task starts. Strongly recommended." />
          </>
        }
        description="Validate non-overlapping claims before parallel writers run."
      >
        <Toggle
          checked={settings.schedulerWritePathValidation}
          onChange={(schedulerWritePathValidation) => onChange({ schedulerWritePathValidation })}
        />
      </SettingCard>

      {metrics && (
        <>
          <SectionTitle>Fleet stats this week</SectionTitle>
          <SettingCard title="Fleet runs" description="Total fleet tool invocations.">
            <span className="hint">{metrics.fleet.runs}</span>
          </SettingCard>
          <SettingCard title="Write-path conflicts" description="Preflight rejections due to overlapping claims.">
            <span className="hint">{metrics.fleet.conflicts}</span>
          </SettingCard>
          <SettingCard title="Background jobs completed" description="task(is_background=true) completions.">
            <span className="hint">{metrics.fleet.backgroundJobsCompleted}</span>
          </SettingCard>
        </>
      )}

      <ReasonixDevTools threadId={activeThreadId} title="Fleet execution timeline" />
    </div>
  );
}
