import { useState } from "react";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type { DeyinSettings } from "../../../shared/types.js";

interface Props {
  settings: DeyinSettings;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

export function BrowserPage({ settings, onChange }: Props) {
  const [note, setNote] = useState<string | null>(null);

  const clearCache = async () => {
    await window.deyin.browserData.clearCache();
    setNote("Browser cache cleared.");
  };
  const clearAll = async () => {
    await window.deyin.browserData.clearAll();
    setNote("All browser data cleared.");
  };

  return (
    <div className="settings-page">
      <PageHeader title="Browser" description="The built-in browser used by agent sessions and previews." />

      <SectionTitle>Browser control</SectionTitle>
      <SettingCard
        title="Enable built-in browser control"
        description="Allow the Browser Use plugin to open, inspect and control pages in the built-in browser for new sessions."
      >
        <Toggle
          checked={settings.browserControlEnabled}
          onChange={(v) => onChange({ browserControlEnabled: v })}
        />
      </SettingCard>

      <SectionTitle>Browser data</SectionTitle>
      <SettingCard
        title="Clear built-in browser cache"
        description="Clear the HTTP cache, Cache Storage and service workers while keeping cookies and local site data."
      >
        <button className="btn btn--outline" onClick={clearCache}>Clear cache</button>
      </SettingCard>
      <SettingCard
        title="Clear all browser data"
        description="Delete cookies, site data and cache from the built-in browser. This cannot be undone."
      >
        <button className="btn btn--danger" onClick={clearAll}>Clear all</button>
      </SettingCard>

      {note && <div className="hint" style={{ marginTop: 10 }}>{note}</div>}
    </div>
  );
}
