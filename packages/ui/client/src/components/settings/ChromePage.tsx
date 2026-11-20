import { useEffect, useState } from "react";
import type { ChromeBridgeStatus, DeyinSettings } from "@deyin/contract";
import { ChromeApprovedSites } from "./ChromeApprovedSites.js";
import { ChromeConnectionCard } from "./ChromeConnectionCard.js";
import { SectionHeader, SettingCard, SettingGroup, SettingsPageBlock, Tag, Toggle } from "./controls.js";

interface Props {
  settings: DeyinSettings;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

type ChromeApi = NonNullable<typeof window.deyin.chrome>;

/**
 * `chrome` is a desktop-only IPC namespace; the web transport leaves it
 * undefined. Resolve it once here so everything below takes it as required.
 */
export function ChromePage({ settings, onChange }: Props) {
  const api = window.deyin.chrome;
  if (!api) {
    return (
      <SettingsPageBlock
        title="Chrome"
        description="Use your own Chrome, with your logins, from Deyin. Available in the desktop app only."
        continued
      />
    );
  }
  return <ChromeSettings api={api} settings={settings} onChange={onChange} />;
}

function useChromeStatus(api: ChromeApi): ChromeBridgeStatus | null {
  const [status, setStatus] = useState<ChromeBridgeStatus | null>(null);
  useEffect(() => {
    let live = true;
    void api.getStatus().then((s) => {
      if (live) setStatus(s);
    });
    const off = api.onStatus((s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, [api]);
  return status;
}

function ChromeSettings({ api, settings, onChange }: Props & { api: ChromeApi }) {
  const status = useChromeStatus(api);
  const enabled = settings.chromeControlEnabled;

  return (
    <SettingsPageBlock
      title="Chrome"
      description="Work in your real Chrome, with your logins and extensions, from separate background tabs. Your own tabs and focus are left alone."
      continued
    >
      <SettingGroup>
        <SettingCard
          title="Enable Chrome control"
          description="Lets the Chrome plugin open and use tabs in your browser through the Deyin extension. Nothing connects until you pair it."
        >
          <Toggle checked={enabled} onChange={(v) => onChange({ chromeControlEnabled: v })} />
        </SettingCard>
      </SettingGroup>

      {enabled && status && (
        <>
          <SectionHeader title="Connection" />
          <SettingGroup>
            <ChromeConnectionCard api={api} status={status} />
          </SettingGroup>

          <SectionHeader title="Install the extension" />
          <ChromeInstallSteps api={api} status={status} />

          <SectionHeader title="Tabs" />
          <SettingGroup>
            <ChromeTabs api={api} status={status} />
            <SettingCard title="New tabs open in" description="Where Deyin puts the tabs it opens.">
              <select
                className="select"
                value={settings.chromeTabStrategy}
                onChange={(e) => onChange({ chromeTabStrategy: e.target.value === "window" ? "window" : "group" })}
                aria-label="Where new tabs open"
              >
                <option value="group">A “Deyin” tab group in your current window</option>
                <option value="window">A separate window</option>
              </select>
            </SettingCard>
          </SettingGroup>

          <SectionHeader title="Sites" />
          <SettingGroup>
            <ChromeApprovedSites api={api} />
          </SettingGroup>

          <p className="settings-block__desc">
            Deyin can only see tabs it opened or tabs you share from the extension popup. Pressing <strong>Stop</strong> here
            or in the extension detaches everything at once. Incognito windows and pages like <code>chrome://</code> are never
            used.
          </p>
        </>
      )}
    </SettingsPageBlock>
  );
}

function ChromeInstallSteps({ api, status }: { api: ChromeApi; status: ChromeBridgeStatus }) {
  const [copied, setCopied] = useState(false);
  const path = status.extensionPath;
  const paired = status.pairedBrowsers.length > 0;

  const copy = async (): Promise<void> => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <details className="chrome-steps" open={!paired}>
      <summary>{paired ? "Reinstall or update the extension" : "Steps (about a minute)"}</summary>
      <ol>
        <li>
          In Chrome, open <code>chrome://extensions</code> and turn on <strong>Developer mode</strong>.
        </li>
        <li>
          Choose <strong>Load unpacked</strong> and select this folder:
          {path ? (
            <div className="chrome-path">
              <code>{path}</code>
              <button type="button" className="btn btn--small btn--outline" onClick={() => void api.openExtensionFolder()}>
                Open folder
              </button>
              <button type="button" className="btn btn--small btn--outline" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy path"}
              </button>
            </div>
          ) : (
            <p className="hint hint--bad">This build does not include the extension folder.</p>
          )}
        </li>
        <li>
          Here, choose <strong>Pair Chrome</strong>. Then click the Deyin icon in Chrome&rsquo;s toolbar (pin it from the puzzle
          menu if you don&rsquo;t see it).
        </li>
        <li>
          If the popup shows the same code, click <strong>Allow</strong>. After a Deyin update, press <strong>Reload</strong> on the
          extension card in <code>chrome://extensions</code>.
        </li>
      </ol>
    </details>
  );
}

function ChromeTabs({ api, status }: { api: ChromeApi; status: ChromeBridgeStatus }) {
  const [busy, setBusy] = useState(false);
  const hasAgentTabs = status.tabs.some((t) => t.kind === "agent");

  const closeAll = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.closeAgentTabs();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingCard
      title="Tabs Deyin can use"
      description={status.tabs.length === 0 ? "None right now. Deyin opens its own tabs when a task needs your browser." : undefined}
    >
      <div className="chrome-tabs">
        {status.tabs.map((tab) => (
          <div key={tab.id} className="chrome-tabs__row">
            <Tag tone={tab.kind === "agent" ? "muted" : "warn"}>{tab.kind === "agent" ? "Deyin" : "Shared"}</Tag>
            <span className="chrome-tabs__title" title={tab.url}>
              {tab.title || tab.url}
            </span>
          </div>
        ))}
        <button type="button" className="btn btn--small btn--outline" disabled={busy || !hasAgentTabs} onClick={() => void closeAll()}>
          Close Deyin tabs
        </button>
      </div>
    </SettingCard>
  );
}
