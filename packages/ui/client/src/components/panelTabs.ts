import type { PanelTab } from "./panelTypes.js";

/** Right-panel tab metadata — shared by the icon rail and the expanded tab bar. */
export interface PanelTabDef {
  id: PanelTab;
  label: string;
  /** Icon glyph name from `Icon.tsx`. */
  icon: string;
}

export const PANEL_TABS: PanelTabDef[] = [
  { id: "files", label: "Files", icon: "folderOpen" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "plan", label: "Plan", icon: "map" },
  { id: "preview", label: "Preview", icon: "layout" },
  { id: "diff", label: "Diff", icon: "diff" },
  { id: "git", label: "Git", icon: "gitBranch" },
  { id: "browser", label: "Browser", icon: "globe" },
  { id: "security", label: "Security", icon: "shield" },
  { id: "agent", label: "Agent", icon: "sparkles" },
];

export function panelTabDef(id: PanelTab): PanelTabDef {
  return PANEL_TABS.find((t) => t.id === id) ?? PANEL_TABS[0]!;
}
