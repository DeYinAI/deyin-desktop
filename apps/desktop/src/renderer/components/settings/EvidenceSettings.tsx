import { useEffect, useState } from "react";
import type { DeyinSettings, Advanced agentMetricsSnapshot } from "../../../shared/types.js";
import { HelpTooltip } from "../HelpTooltip.js";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";

interface Props {
  settings: DeyinSettings;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

export function EvidenceSettings({ settings, onChange }: Props) {
  const [metrics, setMetrics] = useState<Advanced agentMetricsSnapshot | null>(null);

  useEffect(() => {
    void window.deyin.agent?.metrics().then(setMetrics).catch(() => setMetrics(null));
  }, []);

  return (
    <div className="settings-page">
      <PageHeader
        title="Delivery & evidence"
        description="Production-ready quality gates: todos with acceptance criteria, verification commands, and complete_step sign-offs."
      />

      <SectionTitle>Feature flags</SectionTitle>
      <SettingCard
        title="Delivery mode"
        description="Show Delivery in the composer mode switcher and enforce evidence gates during agent runs."
      >
        <Toggle
          checked={settings.enableDeliveryMode}
          onChange={(enableDeliveryMode) => onChange({ enableDeliveryMode })}
        />
      </SettingCard>

      <SectionTitle>Gates</SectionTitle>
      <SettingCard
        title={
          <>
            Require acceptance criteria
            <HelpTooltip text="Blocks write/edit/bash mutations until todo_write includes acceptanceCriteria on active steps." />
          </>
        }
        description="Mutations require todos with verification criteria."
      >
        <Toggle
          checked={settings.evidenceRequireAcceptanceCriteria}
          disabled={!settings.enableDeliveryMode}
          onChange={(evidenceRequireAcceptanceCriteria) => onChange({ evidenceRequireAcceptanceCriteria })}
        />
      </SettingCard>
      <SettingCard
        title={
          <>
            Strict finalization
            <HelpTooltip text="Agent cannot finish until every todo is signed off via complete_step and marked completed." />
          </>
        }
        description="Block done responses until all evidence requirements are met."
      >
        <Toggle
          checked={settings.evidenceStrictFinalization}
          disabled={!settings.enableDeliveryMode}
          onChange={(evidenceStrictFinalization) => onChange({ evidenceStrictFinalization })}
        />
      </SettingCard>

      {metrics && settings.enableDeliveryMode && (
        <>
          <SectionTitle>Stats this week</SectionTitle>
          <SettingCard title="Gate rejections" description="Mutations or finalization blocked by delivery gates.">
            <span className="hint">{metrics.evidence.gateRejections}</span>
          </SettingCard>
          <SettingCard title="Sign-offs" description="Successful complete_step calls.">
            <span className="hint">{metrics.evidence.signOffs}</span>
          </SettingCard>
        </>
      )}

      <p className="settings-page__desc">
        See <code>docs/EVIDENCE_DELIVERY.md</code> and <code>docs/guides/evidence-workflow-tutorial.md</code> for the
        full workflow.
      </p>
    </div>
  );
}
