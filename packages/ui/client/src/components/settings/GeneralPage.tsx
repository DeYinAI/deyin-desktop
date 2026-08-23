import { useEffect, useState } from "react";
import { LOCALES } from "@deyin/host-core/shared";
import { useT } from "../../i18n.js";
import { SettingGroup, PageHeader, SectionHeader, SettingCard, Toggle } from "./controls.js";
import type { DeyinSettings, UpdatesState } from "@deyin/contract";

interface Props {
  settings: DeyinSettings;
  version: string;
  platform?: "desktop" | "web";
  onChange: (patch: Partial<DeyinSettings>) => void;
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));
}

export function GeneralPage({ settings, version, platform, onChange }: Props) {
  const t = useT();
  const isDesktop = platform !== "web" && typeof window.deyin?.updates?.check === "function";
  const [updateState, setUpdateState] = useState<UpdatesState | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    void window.deyin.updates.getState().then(setUpdateState);
    const off = window.deyin.updates.onState(setUpdateState);
    return off;
  }, [isDesktop]);

  const handleCheckForUpdates = async () => {
    if (!isDesktop) return;
    setChecking(true);
    try {
      const next = await window.deyin.updates.check({ userInitiated: true });
      setUpdateState(next);
    } finally {
      setChecking(false);
    }
  };

  const updateHint = (() => {
    if (!isDesktop || !updateState) return null;
    if (checking || updateState.status === "checking") return t("general.checkForUpdatesChecking");
    if (updateState.status === "not-available") {
      return fill(t("general.checkForUpdatesUpToDate"), { version: updateState.currentVersion ?? version });
    }
    if (updateState.status === "unsupported") return null;
    if (updateState.status === "error") {
      return fill(t("general.checkForUpdatesError"), { message: updateState.error ?? "unknown" });
    }
    if (updateState.status === "available" && updateState.availableVersion) {
      return fill(t("update.available"), { version: updateState.availableVersion });
    }
    if (updateState.status === "downloaded" && updateState.availableVersion) {
      return fill(t("update.downloaded"), { version: updateState.availableVersion });
    }
    return null;
  })();

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
        {isDesktop ? (
          <>
            <SettingCard title={t("general.autoUpdate")} description={t("general.autoUpdateDesc")}>
              <Toggle checked={settings.autoUpdate} onChange={(v) => onChange({ autoUpdate: v })} />
            </SettingCard>
            <SettingCard title={t("general.checkForUpdates")} description={t("general.checkForUpdatesDesc")}>
              <div className="settings-inline-actions">
                <button
                  type="button"
                  className="btn btn--secondary btn--small"
                  disabled={checking}
                  onClick={() => void handleCheckForUpdates()}
                >
                  {checking ? t("general.checkForUpdatesChecking") : t("general.checkForUpdatesButton")}
                </button>
                {updateHint ? <span className="hint">{updateHint}</span> : null}
              </div>
            </SettingCard>
          </>
        ) : null}
        <SettingCard title={t("general.agentMode")} description={t("general.agentModeDesc")}>
          <Toggle
            checked={settings.agentMode === "agent"}
            onChange={(v) => onChange({ agentMode: v ? "agent" : "chat" })}
          />
        </SettingCard>
        <SettingCard title={t("general.keepRunningInBackground")} description={t("general.keepRunningInBackgroundDesc")}>
          <Toggle checked={settings.keepRunningInBackground} onChange={(v) => onChange({ keepRunningInBackground: v })} />
        </SettingCard>
        <SettingCard title={t("general.automationsCatchUp")} description={t("general.automationsCatchUpDesc")}>
          <Toggle checked={settings.automationsCatchUp} onChange={(v) => onChange({ automationsCatchUp: v })} />
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
