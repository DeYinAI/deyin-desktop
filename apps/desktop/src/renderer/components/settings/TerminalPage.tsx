import { useEffect, useState } from "react";
import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type { DeyinSettings, EnvInfo } from "../../../shared/types.js";

interface Props {
  settings: DeyinSettings;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

/** Terminal defaults: shell (incl. WSL2 distros), font size, scrollback. */
export function TerminalPage({ settings, onChange }: Props) {
  const [env, setEnv] = useState<EnvInfo | null>(null);

  useEffect(() => {
    void window.deyin.env.detect().then(setEnv).catch(() => setEnv(null));
  }, []);

  const shells = env?.shells ?? [];
  const detectedDefault = shells.find((s) => s.id === env?.defaultShell)?.label;

  return (
    <div className="settings-page">
      <PageHeader title="Terminal" description="Defaults for integrated terminal sessions." />

      <SectionTitle>Shell</SectionTitle>
      <SettingCard
        title="Default shell"
        description={
          env?.wsl2
            ? "WSL2 distros are detected automatically and listed alongside native shells."
            : "New terminals start with this shell."
        }
      >
        <select
          className="select"
          value={settings.defaultShell ?? ""}
          onChange={(e) => onChange({ defaultShell: e.target.value === "" ? null : e.target.value })}
        >
          <option value="">{detectedDefault ? `Auto (${detectedDefault})` : "Auto-detect"}</option>
          {shells.map((shell) => (
            <option key={shell.id} value={shell.id}>
              {shell.label}
              {shell.kind === "wsl" ? " (WSL2)" : ""}
            </option>
          ))}
        </select>
      </SettingCard>
      {env && env.wslDistros.length > 0 && (
        <SettingCard
          title="WSL2 distributions"
          description={`Detected: ${env.wslDistros.join(", ")}. Pick one above to make it the default.`}
        />
      )}

      <SectionTitle>Display</SectionTitle>
      <SettingCard title="Font size" description="Terminal text size; applies to open sessions immediately.">
        <div className="range-row">
          <input
            type="range"
            min={10}
            max={20}
            value={settings.terminalFontSize}
            onChange={(e) => onChange({ terminalFontSize: Number(e.target.value) })}
          />
          <span className="hint">{settings.terminalFontSize}px</span>
        </div>
      </SettingCard>
      <SettingCard title="Scrollback" description="Lines of output kept per session.">
        <select
          className="select"
          value={String(settings.terminalScrollback)}
          onChange={(e) => onChange({ terminalScrollback: Number(e.target.value) })}
        >
          <option value="1000">1,000</option>
          <option value="5000">5,000</option>
          <option value="10000">10,000</option>
          <option value="50000">50,000</option>
        </select>
      </SettingCard>

      <SectionTitle>Agent</SectionTitle>
      <SettingCard
        title="Reveal terminal on agent command"
        description="Open the terminal panel and focus the Agent tab when the chat agent first runs a shell command."
      >
        <Toggle
          checked={settings.revealTerminalOnAgentCommand}
          onChange={(v) => onChange({ revealTerminalOnAgentCommand: v })}
        />
      </SettingCard>
      <SettingCard
        title="Agent shell marker"
        description="Agent-spawned shells set DEYIN_AGENT=1 so your dotfiles can skip heavy prompts and banners. The agent uses its own persistent PTY — never your personal tabs."
      />
    </div>
  );
}
