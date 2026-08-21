import { LOCALES } from "@deyin/host-core/shared";
import { useT } from "../../i18n.js";
import { SettingGroup, PageHeader, SectionHeader, SettingCard, Toggle } from "./controls.js";
import type { DeyinSettings } from "@deyin/contract";

interface Props {
  settings: DeyinSettings;
  version: string;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

export function GeneralPage({ settings, version, onChange }: Props) {
  const t = useT();
  return (
    <div className="settings-page">
      <PageHeader title={t("general.title")} description={t("general.desc")} />

      <SectionHeader title={t("general.application")} />
      <SettingGroup>
        <SettingCard title={t("general.language")} description={t("general.languageDesc")}>
          <select
            className="select"
            value={settings.language}
            onChange={(e) => onChange({ language: e.target.value })}
          >
            {LOCALES.map((locale) => (
              <option key={locale.id} value={locale.id}>{locale.label}</option>
            ))}
          </select>
        </SettingCard>
        <SettingCard title={t("general.autoUpdate")} description={t("general.autoUpdateDesc")}>
          <Toggle checked={settings.autoUpdate} onChange={(v) => onChange({ autoUpdate: v })} />
        </SettingCard>
        <SettingCard title={t("general.agentMode")} description={t("general.agentModeDesc")}>
          <Toggle
            checked={settings.agentMode === "agent"}
            onChange={(v) => onChange({ agentMode: v ? "agent" : "chat" })}
          />
        </SettingCard>
        <SettingCard title={t("general.keepRunningInBackground")} description={t("general.keepRunningInBackgroundDesc")}>
          <Toggle checked={settings.keepRunningInBackground} onChange={(v) => onChange({ keepRunningInBackground: v })} />
        </SettingCard>
        <SettingCard
          title="Change review"
          description="Queue file edits for review before applying to disk. Also enabled automatically in Ask before changes mode."
        >
          <select
            className="select"
            value={settings.reviewMode ?? "off"}
            onChange={(e) => onChange({ reviewMode: e.target.value as "off" | "on" })}
          >
            <option value="off">Apply immediately</option>
            <option value="on">Review before apply</option>
          </select>
        </SettingCard>
      </SettingGroup>

      <SectionHeader title={t("general.privacy")} />
      <SettingGroup>
        <SettingCard title={t("general.telemetry")} description={t("general.telemetryDesc")}>
          <Toggle checked={settings.telemetry} onChange={(v) => onChange({ telemetry: v })} />
        </SettingCard>
      </SettingGroup>

      <SectionHeader title={t("general.about")} />
      <SettingGroup>
        <SettingCard title={t("general.version")} description={t("general.versionDesc")}>
          <span className="hint">{version}</span>
        </SettingCard>
      </SettingGroup>
    </div>
  );
}
