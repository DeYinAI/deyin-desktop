import { useCallback, useEffect, useState } from "react";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type { ComputerUseHostStatus, DeyinSettings } from "@deyin/contract";

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
  const computerUseOn = settings.computerUseEnabled && isWindows;
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [pickerApps, setPickerApps] = useState<AppRow[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [manualAppId, setManualAppId] = useState("");
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hostStatus, setHostStatus] = useState<ComputerUseHostStatus | null>(null);
  const [checkingHost, setCheckingHost] = useState(false);

  const refreshAllowlist = useCallback(async () => {
    const apps = await api.getAllowlist();
    setAllowlist(apps);
  }, [api]);

  const refreshHostStatus = useCallback(async () => {
    setCheckingHost(true);
    try {
      const status = await api.getHostStatus();
      setHostStatus(status);
    } catch (err) {
      setHostStatus({
        ok: false,
        error: err instanceof Error ? err.message : "Could not check computer use host.",
      });
    } finally {
      setCheckingHost(false);
    }
  }, [api]);

  useEffect(() => {
    void refreshAllowlist();
  }, [refreshAllowlist]);

  useEffect(() => {
    void refreshHostStatus();
  }, [refreshHostStatus, computerUseOn]);

  const pickApps = async (): Promise<void> => {
    if (!computerUseOn) {
      setPickerError("Enable computer use above before picking apps.");
      return;
    }
    setLoadingApps(true);
    setPickerError(null);
    try {
      const rows = (await api.listApps()) as AppRow[];
      setPickerApps(Array.isArray(rows) ? rows : []);
      if (!Array.isArray(rows) || rows.length === 0) {
        setPickerError("No apps returned. Check host status below or add apps manually.");
      }
    } catch (err) {
      setPickerApps([]);
      setPickerError(
        err instanceof Error ? err.message : "Could not list apps — is the computer-use host running?",
      );
    } finally {
      setLoadingApps(false);
    }
  };

  const addApp = async (id: string): Promise<void> => {
    const trimmed = id.trim();
    if (!trimmed || allowlist.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) return;
    setActionError(null);
    try {
      const next = [...allowlist, trimmed];
      const saved = await api.setAllowlist(next);
      setAllowlist(saved);
      setManualAppId("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not save allowlist.");
    }
  };

  const removeApp = async (id: string): Promise<void> => {
    setActionError(null);
    try {
      const next = allowlist.filter((a) => a !== id);
      const saved = await api.setAllowlist(next);
      setAllowlist(saved);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update allowlist.");
    }
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
          checked={computerUseOn}
          disabled={!isWindows}
          onChange={(v) => onChange({ computerUseEnabled: v })}
        />
      </SettingCard>

      {isWindows && (
        <SettingCard
          title="Host status"
          description="The native Windows sidecar must be running for listing apps and automation."
        >
          <div className="settings-page__actions" style={{ alignItems: "center", gap: 12 }}>
            {checkingHost ? (
              <span className="hint">Checking host…</span>
            ) : hostStatus?.ok ? (
              <span className="hint hint--ok">Connected</span>
            ) : (
              <span className="hint hint--bad">{hostStatus?.error ?? "Host unavailable"}</span>
            )}
            <button type="button" className="btn btn--small" disabled={checkingHost} onClick={() => void refreshHostStatus()}>
              Recheck
            </button>
          </div>
          {hostStatus?.hostPath && !hostStatus.ok && (
            <p className="hint" style={{ marginTop: 8 }}>
              Expected host: <code>{hostStatus.hostPath}</code>
              {hostStatus.hostExists === false ? " (missing)" : ""}
              {hostStatus.hostExists !== false ? (
                <>
                  {" "}
                  · Log: <code>%APPDATA%\Deyin\computer-use\host.log</code>
                </>
              ) : null}
            </p>
          )}
        </SettingCard>
      )}

      <SectionTitle>Always-allowed apps</SectionTitle>
      <p className="settings-page__desc" style={{ margin: "0 0 10px" }}>
        When the agent uses an app for the first time, you'll be asked to allow it. Choose <strong>Always allow</strong>{" "}
        to skip future prompts — those apps appear here. You can also pre-add apps below (use process names like{" "}
        <code>notepad</code> or <code>chrome</code>).
      </p>
      {actionError && <p className="hint hint--bad">{actionError}</p>}
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
        <input
          type="text"
          className="input"
          placeholder="App id (e.g. notepad)"
          value={manualAppId}
          disabled={!isWindows}
          onChange={(e) => setManualAppId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addApp(manualAppId);
          }}
          aria-label="App id to allow"
        />
        <button
          type="button"
          className="btn"
          disabled={!isWindows || !manualAppId.trim()}
          onClick={() => void addApp(manualAppId)}
        >
          Add app
        </button>
        <button
          type="button"
          className="btn"
          disabled={!isWindows || !computerUseOn || loadingApps}
          onClick={() => void pickApps()}
        >
          {loadingApps ? "Loading apps…" : "Pick apps"}
        </button>
      </div>
      {!computerUseOn && isWindows && (
        <p className="hint">Enable computer use to browse installed apps from the native host.</p>
      )}
      {pickerError && <p className="hint hint--bad">{pickerError}</p>}
      {pickerApps.length > 0 && (
        <ul className="settings-list">
          {pickerApps.slice(0, 40).map((app) => (
            <li key={app.id ?? app.name}>
              <span>
                {app.name ?? app.id}
                {app.id ? ` (${app.id})` : ""}
              </span>
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
