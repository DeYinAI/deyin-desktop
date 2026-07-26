import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type { DeyinSettings } from "../../../shared/types.js";

interface Props {
  settings: DeyinSettings;
  version: string;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

export function GeneralPage({ settings, version, onChange }: Props) {
  return (
    <div className="settings-page">
      <PageHeader title="General" description="Application behavior and updates." />

      <SectionTitle>Application</SectionTitle>
      <SettingCard title="Language" description="Language used across the interface.">
        <select
          className="select"
          value={settings.language}
          onChange={(e) => onChange({ language: e.target.value })}
        >
          <option value="en">English</option>
          <option value="zh">中文</option>
          <option value="de">Deutsch</option>
        </select>
      </SettingCard>
      <SettingCard
        title="Automatic updates"
        description="Download and install new versions of Deyin in the background."
      >
        <Toggle checked={settings.autoUpdate} onChange={(v) => onChange({ autoUpdate: v })} />
      </SettingCard>

      <SectionTitle>Privacy</SectionTitle>
      <SettingCard
        title="Usage telemetry"
        description="Share anonymous usage metrics to help improve Deyin. Off by default."
      >
        <Toggle checked={settings.telemetry} onChange={(v) => onChange({ telemetry: v })} />
      </SettingCard>

      <SectionTitle>About</SectionTitle>
      <SettingCard title="Version" description="Current Deyin build.">
        <span className="hint">{version}</span>
      </SettingCard>
    </div>
  );
}
