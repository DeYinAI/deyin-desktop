import { useEffect, useState } from "react";
import type { DeyinSettings, Advanced agentMetricsSnapshot } from "../../../shared/types.js";
import { HelpTooltip } from "../HelpTooltip.js";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import { Advanced agentDevTools } from "./Advanced agentDevTools.js";

interface Props {
  settings: DeyinSettings;
  activeThreadId?: string | null;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

export function CacheSettings({ settings, activeThreadId, onChange }: Props) {
  const [metrics, setMetrics] = useState<Advanced agentMetricsSnapshot | null>(null);

  useEffect(() => {
    void window.deyin.agent?.metrics().then(setMetrics).catch(() => setMetrics(null));
  }, []);

  const hitRatePct = metrics ? (metrics.cache.hitRate * 100).toFixed(1) : "—";
  const targetPct = (settings.cacheHitRateTarget * 100).toFixed(0);
  const warnPct = (settings.cacheHitRateWarningThreshold * 100).toFixed(0);

  return (
    <div className="settings-page">
      <PageHeader
        title="Prefix cache"
        description="DeepSeek-style prefix caching keeps system prompt, tool schemas, and conversation history stable for lower token cost."
      />

      <SectionTitle>Feature flags</SectionTitle>
      <SettingCard
        title="Cache optimizations"
        description="Enable prompt_cache_key markers and prefix stability tracking. Proven stable — recommended on."
      >
        <Toggle
          checked={settings.enableCacheOptimizations}
          onChange={(enableCacheOptimizations) => onChange({ enableCacheOptimizations })}
        />
      </SettingCard>
      <SettingCard
        title="Provider prompt caching"
        description="Send cache markers to OpenAI-compatible providers (works with Optimization page toggle)."
      >
        <Toggle
          checked={settings.optimizationPromptCaching}
          disabled={!settings.enableCacheOptimizations}
          onChange={(optimizationPromptCaching) => onChange({ optimizationPromptCaching })}
        />
      </SettingCard>

      <SectionTitle>Thresholds</SectionTitle>
      <SettingCard
        title={
          <>
            Target hit rate ({targetPct}%)
            <HelpTooltip text="Session cache hit rate at or above this value shows green in the status bar." />
          </>
        }
        description="Performance target for multi-turn sessions."
      >
        <input
          type="range"
          min={0.5}
          max={0.95}
          step={0.05}
          value={settings.cacheHitRateTarget}
          onChange={(e) => onChange({ cacheHitRateTarget: Number(e.target.value) })}
        />
      </SettingCard>
      <SettingCard
        title={
          <>
            Warning threshold ({warnPct}%)
            <HelpTooltip text="Below this rate, cache diagnostics highlight potential prefix instability." />
          </>
        }
        description="Show yellow/red indicators when hit rate drops."
      >
        <input
          type="range"
          min={0.2}
          max={0.8}
          step={0.05}
          value={settings.cacheHitRateWarningThreshold}
          onChange={(e) => onChange({ cacheHitRateWarningThreshold: Number(e.target.value) })}
        />
      </SettingCard>

      <SectionTitle>Session stats</SectionTitle>
      <SettingCard title="Aggregated hit rate" description="Privacy-respecting counters across all sessions this week.">
        <span className="hint">{hitRatePct}%</span>
      </SettingCard>
      {metrics && (
        <SettingCard title="Invalidations / compactions" description="Prefix changes attributed this week.">
          <span className="hint">
            {metrics.cache.invalidations} invalidations · {metrics.cache.compactions} compactions
          </span>
        </SettingCard>
      )}

      <Advanced agentDevTools threadId={activeThreadId} title="Cache diagnostics" />
    </div>
  );
}
