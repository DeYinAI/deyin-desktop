import { useCallback, useEffect, useState } from "react";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type { DeyinSettings } from "@deyin/contract";

interface Props {
  settings: DeyinSettings;
  onChange(patch: Partial<DeyinSettings>): void;
}

interface AppRow {
  id?: string;
  name?: string;
}

type ComputerUseApi = NonNullable<typeof window.deyin.computerUse>;

/**
 * `computerUse` is a desktop-only IPC namespace — the web transport leaves it
 * undefined. Resolve it once here so the page below can take it as a required
 * prop instead of guarding at every call site.
 */
export function ComputerUsePage({ settings, onChange }: Props) {
  const api = window.deyin.computerUse;
  if (!api) {
    return (
      <div className="settings-page">
        <PageHeader
          title="Computer Use"
          description="OS-level desktop automation on Windows. Not available in the web app."
        />
      </div>
    );
  }
  return <ComputerUseSettings api={api} settings={settings} onChange={onChange} />;
}

function ComputerUseSettings({ api, settings, onChange }: Props & { api: ComputerUseApi }) {
  const isWindows = navigator.userAgent.includes("Windows");
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [pickerApps, setPickerApps] = useState<AppRow[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);

  const refreshAllowlist = useCallback(async () => {
    const apps = await api.getAllowlist();
    setAllowlist(apps);
  }, [api]);

  useEffect(() => {
    void refreshAllowlist();
  }, [refreshAllowlist]);

  const pickApps = async (): Promise<void> => {
    setLoadingApps(true);
    try {
      const rows = (await api.listApps()) as AppRow[];
      setPickerApps(Array.isArray(rows) ? rows : []);
    } catch {
      setPickerApps([]);
    } finally {
      setLoadingApps(false);
    }
  };

  const addApp = async (id: string): Promise<void> => {
    if (!id || allowlist.includes(id)) return;
    const next = [...allowlist, id];
    await api.setAllowlist(next);
    setAllowlist(next);
  };

  const removeApp = async (id: string): Promise<void> => {
    const next = allowlist.filter((a) => a !== id);
    await api.setAllowlist(next);
    setAllowlist(next);
  };

  return (
    <div className="settings-page">
      <PageHeader
        title="Computer Use"
        description="OS-level desktop automation on Windows. Control allowed apps via accessibility tree and screenshots."
      />
      <SettingCard
        title="Enable computer use"
        description={
          isWindows
            ? "Allows computer_* agent tools when the Computer Use plugin is enabled. First use of an app prompts for approval."
            : "Available on Windows only. This platform shows a disabled preview."
        }
      >
        <Toggle
          checked={settings.computerUseEnabled && isWindows}
          disabled={!isWindows}
          onChange={(v) => onChange({ computerUseEnabled: v })}
        />
      </SettingCard>

      <SectionTitle>Always-allowed apps</SectionTitle>
      <p className="settings-page__desc" style={{ margin: "0 0 10px" }}>
        When the agent uses an app for the first time, you'll be asked to allow it. Choose <strong>Always allow</strong>{" "}
        to skip future prompts — those apps appear here. You can also pre-add apps below.
      </p>
      {allowlist.length === 0 ? (
        <p className="hint">No apps on the always-allow list yet. You'll be asked the first time the agent uses an app.</p>
      ) : (
        <div className="chip-list">
          {allowlist.map((appId) => (
            <span key={appId} className="chip">
              {appId}
              <button
                type="button"
                className="chip__remove"
                onClick={() => void removeApp(appId)}
                aria-label={`Remove ${appId}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="settings-page__actions">
        <button type="button" className="btn" disabled={!isWindows || loadingApps} onClick={() => void pickApps()}>
          {loadingApps ? "Loading apps…" : "Pick apps"}
        </button>
      </div>
      {pickerApps.length > 0 && (
        <ul className="settings-list">
          {pickerApps.slice(0, 40).map((app) => (
            <li key={app.id ?? app.name}>
              <span>{app.name ?? app.id}</span>
              <button type="button" className="btn btn--small" disabled={!app.id} onClick={() => void addApp(String(app.id))}>
                Add
              </button>
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>Screenshot retention</SectionTitle>
      <SettingCard title="Keep screenshots" description="Local screenshots older than this are pruned on startup.">
        <select
          value={settings.computerUseScreenshotRetentionDays}
          onChange={(e) => onChange({ computerUseScreenshotRetentionDays: Number(e.target.value) })}
        >
          {[1, 3, 7, 14, 30].map((days) => (
            <option key={days} value={days}>
              {days} day{days === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      </SettingCard>

      <SectionTitle>Privacy</SectionTitle>
      <p className="settings-page__desc">
        Screenshots are stored locally under your user data folder. Press <kbd>Esc</kbd> during automation to cancel.
        Training data is not sent to Deyin servers.
      </p>
    </div>
  );
}
