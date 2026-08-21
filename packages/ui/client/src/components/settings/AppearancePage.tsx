import { CodeBlock, DARK_CODE_THEMES, LIGHT_CODE_THEMES, themeByName } from "../../code.js";
import { useT } from "../../i18n.js";
import { SettingGroup, PageHeader, SectionHeader, SettingCard, Toggle } from "./controls.js";
import type { DeyinSettings } from "@deyin/contract";

const SAMPLE = `interface ThemeConfig {
  surface: string;
  accent: string;
}

// Applied to every code block in chat.
export function apply(config: ThemeConfig): number {
  const contrast = measure(config.accent, "#0d1117");
  return Math.max(contrast, 4.5);
}`;

interface Props {
  settings: DeyinSettings;
  onChange: (patch: Partial<DeyinSettings>) => void;
}

export function AppearancePage({ settings, onChange }: Props) {
  const t = useT();
  return (
    <div className="settings-page">
      <PageHeader title={t("appearance.title")} description={t("appearance.desc")} />

      <SectionHeader title={t("appearance.interface")} />
      <SettingGroup>
      <SettingCard title={t("appearance.colorTheme")} description={t("appearance.colorThemeDesc")}>
        <select
          className="select"
          value={settings.theme}
          onChange={(e) => onChange({ theme: e.target.value as DeyinSettings["theme"] })}
        >
          <option value="dark">{t("appearance.dark")}</option>
          <option value="light">{t("appearance.light")}</option>
          <option value="system">{t("appearance.system")}</option>
        </select>
      </SettingCard>
      <SettingCard title={t("appearance.fontSize")} description={t("appearance.fontSizeDesc")}>
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
      </SettingGroup>

      <SectionHeader title={t("appearance.codeDisplay")} />
      <SettingGroup>
      <SettingCard title={t("appearance.lightCodeTheme")} description="Highlighting palette used with the light interface.">
        <select
          className="select"
          value={settings.codeThemeLight}
          onChange={(e) => onChange({ codeThemeLight: e.target.value })}
        >
          {LIGHT_CODE_THEMES.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </SettingCard>
      <SettingCard title={t("appearance.darkCodeTheme")} description="Highlighting palette used with the dark interface.">
        <select
          className="select"
          value={settings.codeThemeDark}
          onChange={(e) => onChange({ codeThemeDark: e.target.value })}
        >
          {DARK_CODE_THEMES.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </SettingCard>
      <SettingCard title={t("appearance.showLineNumbers")} description="Display line numbers in code and diff views.">
        <Toggle checked={settings.showLineNumbers} onChange={(v) => onChange({ showLineNumbers: v })} />
      </SettingCard>
      <SettingCard title={t("appearance.wrapLongLines")} description="Wrap long code lines automatically.">
        <Toggle checked={settings.wrapLongLines} onChange={(v) => onChange({ wrapLongLines: v })} />
      </SettingCard>
      <SettingCard title={t("appearance.codeFontSize")} description="Default font size for code blocks, file previews and diff views.">
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
      </SettingGroup>

      <SectionHeader title={t("appearance.codePreview")} />
      <p className="settings-page__desc" style={{ margin: "0 0 12px" }}>
        Live preview of both code themes with the current display options. The theme matching the interface is active.
      </p>
      <div className="codepreview">
        <PreviewCard
          title="Light preview"
          themeName={settings.codeThemeLight}
          variant="light"
          active={settings.theme === "light"}
          settings={settings}
        />
        <PreviewCard
          title="Dark preview"
          themeName={settings.codeThemeDark}
          variant="dark"
          active={settings.theme !== "light"}
          settings={settings}
        />
      </div>
    </div>
  );
}

function PreviewCard(props: {
  title: string;
  themeName: string;
  variant: "light" | "dark";
  active: boolean;
  settings: DeyinSettings;
}) {
  const theme = themeByName(props.themeName, props.variant);
  return (
    <div className={`codepreview__card codepreview__card--${props.variant}`}>
      <div className="codepreview__head">
        <div>
          <div className="codepreview__title">{props.title}</div>
          <div className="codepreview__theme">{theme.name}</div>
        </div>
        {props.active ? (
          <span className="badge badge--ok">Active</span>
        ) : (
          <span className="badge badge--muted">{props.variant === "light" ? "Light" : "Dark"}</span>
        )}
      </div>
      <CodeBlock
        code={SAMPLE}
        lang="ts"
        theme={theme}
        fontSize={props.settings.codeFontSize}
        showLineNumbers={props.settings.showLineNumbers}
        wrapLongLines={props.settings.wrapLongLines}
      />
    </div>
  );
}
