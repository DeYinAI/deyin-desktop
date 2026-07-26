import { PageHeader, SectionTitle, SettingCard, Toggle } from "./controls.js";
import type { DeyinSettings } from "../../../shared/types.js";

const LIGHT_THEMES = ["GitHub Light", "One Light", "Solarized Light"];
const DARK_THEMES = ["GitHub Dark", "One Dark", "Midnight"];

interface Props {
  settings: DeyinSettings;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

export function AppearancePage({ settings, onChange }: Props) {
  return (
    <div className="settings-page">
      <PageHeader title="Appearance" description="Interface theme, text and code rendering." />

      <SectionTitle>Interface</SectionTitle>
      <SettingCard title="Color theme" description="Deyin ships dark-first; light theme is in progress.">
        <select
          className="select"
          value={settings.theme}
          onChange={(e) => onChange({ theme: e.target.value as DeyinSettings["theme"] })}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">System</option>
        </select>
      </SettingCard>
      <SettingCard title="Font size" description="Base font size for chat and panels.">
        <div className="range-row">
          <input
            type="range"
            min={12}
            max={18}
            value={settings.fontSize}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          />
          <span className="hint">{settings.fontSize}px</span>
        </div>
      </SettingCard>

      <SectionTitle>Code display</SectionTitle>
      <p className="settings-page__desc" style={{ margin: "0 0 12px" }}>
        Choose code themes, font size and display options independently from the interface font size.
      </p>
      <SettingCard title="Light code theme" description="Highlighting theme used for code content in the light interface.">
        <select
          className="select"
          value={settings.codeThemeLight}
          onChange={(e) => onChange({ codeThemeLight: e.target.value })}
        >
          {LIGHT_THEMES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </SettingCard>
      <SettingCard title="Dark code theme" description="Highlighting theme used for code content in the dark interface.">
        <select
          className="select"
          value={settings.codeThemeDark}
          onChange={(e) => onChange({ codeThemeDark: e.target.value })}
        >
          {DARK_THEMES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </SettingCard>
      <SettingCard title="Show line numbers" description="Display line numbers in code and diff views.">
        <Toggle checked={settings.showLineNumbers} onChange={(v) => onChange({ showLineNumbers: v })} />
      </SettingCard>
      <SettingCard title="Wrap long lines" description="Wrap long code lines automatically.">
        <Toggle checked={settings.wrapLongLines} onChange={(v) => onChange({ wrapLongLines: v })} />
      </SettingCard>
      <SettingCard title="Code font size" description="Default font size for code blocks, file previews and diff views.">
        <div className="range-row">
          <input
            className="input"
            style={{ width: 64, textAlign: "right" }}
            type="number"
            min={10}
            max={20}
            value={settings.codeFontSize}
            onChange={(e) => onChange({ codeFontSize: Number(e.target.value) || 12 })}
          />
          <span className="hint">px</span>
        </div>
      </SettingCard>

      <SectionTitle>Code preview</SectionTitle>
      <p className="settings-page__desc" style={{ margin: "0 0 12px" }}>
        Preview the light and dark code themes together. The theme used by the current interface is marked as active.
      </p>
      <div className="codepreview">
        <PreviewCard
          title="Light preview"
          theme={settings.codeThemeLight}
          variant="light"
          active={settings.theme === "light"}
          fontSize={settings.codeFontSize}
        />
        <PreviewCard
          title="Dark preview"
          theme={settings.codeThemeDark}
          variant="dark"
          active={settings.theme !== "light"}
          fontSize={settings.codeFontSize}
        />
      </div>
    </div>
  );
}

function PreviewCard(props: { title: string; theme: string; variant: "light" | "dark"; active: boolean; fontSize: number }) {
  return (
    <div className={`codepreview__card codepreview__card--${props.variant}`}>
      <div className="codepreview__head">
        <div>
          <div className="codepreview__title">{props.title}</div>
          <div className="codepreview__theme">{props.theme}</div>
        </div>
        {props.active ? <span className="badge badge--ok">Active</span> : <span className="badge badge--muted">{props.variant === "light" ? "Light" : "Dark"}</span>}
      </div>
      <pre className="codepreview__code" style={{ fontSize: props.fontSize }}>
        <span className="cp-line">
          <span className="cp-no">1</span>
          <span className="cp-kw">const</span> <span className="cp-var">themePreview</span>: <span className="cp-type">ThemeConfig</span> = {"{"}
        </span>
        <span className="cp-line">
          <span className="cp-no">2</span>
          {"  "}surface: <span className="cp-str">"sidebar"</span>,
        </span>
        <span className="cp-line">
          <span className="cp-no">3</span>
          {"  "}accent: <span className="cp-str">"#4f7cff"</span>,
        </span>
        <span className="cp-line">
          <span className="cp-no">4</span>
          {"  "}contrast: <span className="cp-num">45</span>,
        </span>
        <span className="cp-line">
          <span className="cp-no">5</span>
          {"}"};
        </span>
      </pre>
    </div>
  );
}
