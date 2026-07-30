import type { DeyinSettings } from "../../../shared/types.js";
import { PageHeader, SettingCard, Toggle } from "./controls.js";

interface Props {
  settings: DeyinSettings;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

export function OptimizationPage({ settings, onChange }: Props) {
  return (
    <div className="settings-page">
      <PageHeader
        title="Token optimization"
        description="Core optimizations are built into Deyin. The optional semantic plugin adds embedding-based caches for redundant tool calls and repeated questions."
      />

      <div className="settings-section">Core</div>
      <SettingCard
        title="Compress payloads"
        description="Strip noise from code, JSON, and tool output before each API request."
      >
        <Toggle
          checked={settings.optimizationCompression}
          onChange={(optimizationCompression) => onChange({ optimizationCompression })}
        />
      </SettingCard>
      <SettingCard title="Compression mode" description="How aggressively to trim payloads.">
        <select
          value={settings.optimizationCompressionMode}
          disabled={!settings.optimizationCompression}
          onChange={(e) =>
            onChange({
              optimizationCompressionMode: e.target.value as DeyinSettings["optimizationCompressionMode"],
            })
          }
        >
          <option value="conservative">Conservative</option>
          <option value="balanced">Balanced</option>
          <option value="aggressive">Aggressive</option>
        </select>
      </SettingCard>
      <SettingCard
        title="Prompt caching"
        description="Send stable prompt_cache_key / cache markers so providers discount repeated prefixes."
      >
        <Toggle
          checked={settings.optimizationPromptCaching}
          onChange={(optimizationPromptCaching) => onChange({ optimizationPromptCaching })}
        />
      </SettingCard>

      <div className="settings-section">Semantic plugin</div>
      <SettingCard
        title="Enable semantic optimization"
        description="Tool-result and response caches with DeYinAI Embedding (hash fallback until ONNX model is installed)."
      >
        <Toggle
          checked={settings.optimizationPluginEnabled}
          onChange={(optimizationPluginEnabled) => onChange({ optimizationPluginEnabled })}
        />
      </SettingCard>
      <SettingCard
        title="Tool result cache"
        description="Reuse prior file reads / searches when arguments are equivalent."
      >
        <Toggle
          checked={settings.optimizationToolCache}
          disabled={!settings.optimizationPluginEnabled}
          onChange={(optimizationToolCache) => onChange({ optimizationToolCache })}
        />
      </SettingCard>
      <SettingCard
        title="Response cache"
        description="Reuse answers for repeated or near-duplicate questions in the same workspace."
      >
        <Toggle
          checked={settings.optimizationResponseCache}
          disabled={!settings.optimizationPluginEnabled}
          onChange={(optimizationResponseCache) => onChange({ optimizationResponseCache })}
        />
      </SettingCard>
      <SettingCard
        title={`Similarity threshold (${settings.optimizationSimilarityThreshold.toFixed(2)})`}
        description="Higher = stricter cache matches."
      >
        <input
          type="range"
          min={0.8}
          max={0.98}
          step={0.01}
          value={settings.optimizationSimilarityThreshold}
          disabled={!settings.optimizationPluginEnabled}
          onChange={(e) => onChange({ optimizationSimilarityThreshold: Number(e.target.value) })}
        />
      </SettingCard>
    </div>
  );
}
