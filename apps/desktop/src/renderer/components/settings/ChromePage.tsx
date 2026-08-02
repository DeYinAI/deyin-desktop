import { PageHeader, SettingCard, Toggle } from "./controls.js";
import type { DeyinSettings } from "../../../shared/types.js";

interface Props {
  settings: DeyinSettings;
  onChange(patch: Partial<DeyinSettings>): void;
}

export function ChromePage({ settings, onChange }: Props) {
  const isWindows = navigator.userAgent.includes("Windows");

  return (
    <div className="settings-page">
      <PageHeader
        title="Chrome"
        description="Attach to your installed Google Chrome for sites that need your logged-in sessions."
      />
      <SettingCard
        title="Enable Chrome automation"
        description={
          isWindows
            ? "Launches or attaches Chrome with remote debugging. You will be asked to consent on first use."
            : "Chrome CDP attach is Windows-only in v1."
        }
      >
        <Toggle
          checked={settings.chromeDebugEnabled && isWindows}
          disabled={!isWindows}
          onChange={(v) => onChange({ chromeDebugEnabled: v })}
        />
      </SettingCard>
    </div>
  );
}
