/** Shared types for the right-hand workspace panel tabs. */

export type PanelTab = "files" | "terminal" | "plan" | "preview" | "diff" | "git" | "browser" | "security" | "agent";

export interface CodeDisplaySettings {
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  codeFontSize: number;
  /** Code theme routing for markdown rendered inside the panel (Plan tab). */
  themeLight?: string;
  themeDark?: string;
  variant?: "light" | "dark";
}
