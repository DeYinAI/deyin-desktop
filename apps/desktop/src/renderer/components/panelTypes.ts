/** Shared types for the right-hand workspace panel tabs. */

export type PanelTab = "files" | "plan" | "diff" | "browser";

export interface CodeDisplaySettings {
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  codeFontSize: number;
  /** Code theme routing for markdown rendered inside the panel (Plan tab). */
  themeLight?: string;
  themeDark?: string;
  variant?: "light" | "dark";
}
