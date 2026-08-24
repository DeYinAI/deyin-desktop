import { useEffect, useState } from "react";
import { SettingGroup, SettingsPageBlock, SectionHeader, SettingCard, Toggle } from "./controls.js";
import type { DeyinSettings, EnvInfo } from "@deyin/contract";

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
    <SettingsPageBlock title="Terminal" description="Defaults for integrated terminal sessions.">

      <SectionHeader title="Shell" />
      <SettingGroup>
      <SettingCard
        title="Default shell"
        description={
          env?.wsl2
            ? "WSL2 distros are detected automatically and listed alongside native shells. The agent's shell follows this choice too."
            : "New terminals and the agent's shell start with this shell."
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
      </SettingGroup>

      <SectionHeader title="Display" />
      <SettingGroup>
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
      <SettingCard title="Cursor" description="Shape of the caret in every terminal session.">
        <select
          className="select"
          value={settings.terminalCursorStyle}
          onChange={(e) =>
            onChange({ terminalCursorStyle: e.target.value as DeyinSettings["terminalCursorStyle"] })
          }
        >
          <option value="bar">Bar</option>
          <option value="block">Block</option>
          <option value="underline">Underline</option>
        </select>
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
      <SettingCard
        title="Copy on selection"
        description="Selecting terminal text puts it on the clipboard straight away."
      >
        <Toggle
          checked={settings.terminalCopyOnSelect}
          onChange={(v) => onChange({ terminalCopyOnSelect: v })}
        />
      </SettingCard>
      </SettingGroup>

      <SectionHeader title="Shortcuts" />
      <SettingGroup>
        <SettingCard
          title="New terminal"
          description="Opens another tab with the default shell."
        >
          <kbd className="kbd">Ctrl/Cmd + Shift + T</kbd>
        </SettingCard>
        <SettingCard title="Close terminal tab" description="Closes the focused session.">
          <kbd className="kbd">Ctrl/Cmd + Shift + W</kbd>
        </SettingCard>
        <SettingCard title="Switch tab" description="Jump straight to the nth session.">
          <kbd className="kbd">Alt + 1…9</kbd>
        </SettingCard>
        <SettingCard
          title="Copy / paste"
          description="Selecting text also copies it automatically."
        >
          <kbd className="kbd">Ctrl/Cmd + Shift + C / V</kbd>
        </SettingCard>
        <SettingCard
          title="Resize the panel"
          description="Drag its top edge, or double-click that edge to maximize and restore."
        />
      </SettingGroup>

      <SectionHeader title="Agent" />
      <SettingGroup>
      <SettingCard
        title="Reveal terminal on agent command"
        description="Open the terminal panel and focus the Agent tab when the chat agent first runs a shell command."
      >
        <Toggle
          checked={settings.revealTerminalOnAgentCommand}
          onChange={(v) => onChange({ revealTerminalOnAgentCommand: v })}
        />
      </SettingCard>
      </SettingGroup>
    </SettingsPageBlock>
  );
}
