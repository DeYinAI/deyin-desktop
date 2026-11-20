/** Deyin design tokens. Original values; a soft, rounded, card-based aesthetic
 * with dark and light interface themes. */

import {
  refAgentColors,
  refAvatars,
  refElevation,
  refLineHeights,
  refStyleDark,
  terminalRefStyle,
} from "./ref-style.js";

export * from "./ref-style.js";

export const brand = {
  name: "Deyin",
  tagline: "Agentic development, with Openference.",
} as const;

/** Dark theme palette (default). Bluish neutral ramp: the window/sidebar
 * ground (#1b1b1c) sits one step above the conversation surface (#151517),
 * cards and the composer use the next step (#2c2c2e), and the accent is a soft
 * blue. */
export const colors = {
  // Surfaces. Ground = sidebar + window chrome, surface = conversation/panels.
  bg: "#1b1b1c",
  surface: "#151517",
  surfaceRaised: "#2c2c2e",
  surfaceOverlay: "#303136",
  border: "rgba(255, 255, 255, 0.12)",
  borderStrong: "rgba(255, 255, 255, 0.2)",
  /** Ultra-subtle internal separator (rows inside cards). */
  hairline: "rgba(255, 255, 255, 0.06)",

  // Text: primary / tertiary / caption steps of the bluish neutral ramp.
  text: "#f9fafb",
  textMuted: "#adb2b8",
  textFaint: "#81858c",

  // Accent (blue-400 on dark)
  accent: "#7aaaff",
  accentHover: "#93b8ff",
  accentSoft: "rgba(122, 170, 255, 0.16)",
  /** Warm counter-accent: the "new chat" mark and other create affordances. */
  accentWarm: "#e2a45c",

  // Send button (info fill, white arrow)
  sendBg: "#7aaaff",
  sendFg: "#ffffff",

  // Status
  success: "#22c55e",
  warning: "#f59e0b",
  danger: "#f25a5a",
  running: "#7aaaff",
} as const;

/** Warm theme palette (HYRAX-inspired): charcoal-brown surfaces, cream text,
 * tan accent, cream CTAs. Dark-only — selected via data-theme="warm". */
export const colorsWarm = {
  bg: "#121110",
  surface: "#1a1816",
  surfaceRaised: "#221e1a",
  surfaceOverlay: "#2a2622",
  border: "#3a3530",
  borderStrong: "#4a443c",
  hairline: "rgba(232, 230, 209, 0.06)",
  text: "#ece6d9",
  textMuted: "#a8a090",
  textFaint: "#6e6558",
  accent: "#c4a072",
  accentHover: "#d4b082",
  accentSoft: "rgba(196, 160, 114, 0.14)",
  accentWarm: "#e2a45c",
  sendBg: "#f2efe8",
  sendFg: "#1a1208",
  success: "#7a9a6a",
  warning: "#c8ad7f",
  danger: "#d14d28",
  running: "#c4a072",
} as const;

/** Light theme palette. */
export const colorsLight = {
  bg: "#f9fafb",
  surface: "#ffffff",
  surfaceRaised: "#f1f3f5",
  surfaceOverlay: "#ffffff",
  border: "rgba(0, 0, 0, 0.12)",
  borderStrong: "rgba(0, 0, 0, 0.2)",
  hairline: "rgba(0, 0, 0, 0.06)",

  text: "#0f1115",
  textMuted: "#81858c",
  textFaint: "#adb2b8",

  accent: "#4176e6",
  accentHover: "#5686fe",
  accentSoft: "rgba(65, 118, 230, 0.12)",
  accentWarm: "#b4690e",

  sendBg: "#4176e6",
  sendFg: "#ffffff",

  success: "#1a7f37",
  warning: "#9a6700",
  danger: "#cf222e",
  running: "#4176e6",
} as const;

/** Obsidian theme palette: deep obsidian slate surfaces, crisp micro-borders,
 * low-glare high-readability text, modern cyan/sky accent. */
export const colorsObsidian = {
  bg: "#0d0e11",
  surface: "#14151a",
  surfaceRaised: "#1c1d24",
  surfaceOverlay: "#22232c",
  border: "rgba(255, 255, 255, 0.08)",
  borderStrong: "rgba(255, 255, 255, 0.18)",
  hairline: "rgba(255, 255, 255, 0.04)",

  text: "#eeeeee",
  textMuted: "rgba(238, 238, 238, 0.62)",
  textFaint: "rgba(238, 238, 238, 0.35)",

  accent: "#38bdf8",
  accentHover: "#60a5fa",
  accentSoft: "rgba(56, 189, 248, 0.14)",
  accentWarm: "#fbbf24",

  sendBg: "#f8fafc",
  sendFg: "#020617",

  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
  running: "#38bdf8",
} as const;

export interface AccentTokens {
  accent: string;
  accentHover: string;
  accentSoft: string;
}

export const ACCENTS: Record<string, AccentTokens> = {
  blue: { accent: "#7aaaff", accentHover: "#93b8ff", accentSoft: "rgba(122, 170, 255, 0.16)" },
  violet: { accent: "#8b5cf6", accentHover: "#a78bfa", accentSoft: "rgba(139, 92, 246, 0.16)" },
  green: { accent: "#00c65a", accentHover: "#34d87a", accentSoft: "rgba(0, 198, 90, 0.16)" },
  amber: { accent: "#eab300", accentHover: "#f5c842", accentSoft: "rgba(234, 179, 0, 0.16)" },
  rose: { accent: "#fb2c36", accentHover: "#ff5a62", accentSoft: "rgba(251, 44, 54, 0.16)" },
  cyan: { accent: "#22d3ee", accentHover: "#39e0f5", accentSoft: "rgba(34, 211, 238, 0.16)" },
  orange: { accent: "#fb923c", accentHover: "#fda85a", accentSoft: "rgba(251, 146, 60, 0.16)" },
  teal: { accent: "#14b8a6", accentHover: "#2dd4bf", accentSoft: "rgba(20, 184, 166, 0.16)" },
  indigo: { accent: "#6366f1", accentHover: "#818cf8", accentSoft: "rgba(99, 102, 241, 0.16)" },
  slate: { accent: "#94a3b8", accentHover: "#b8c1d1", accentSoft: "rgba(148, 163, 184, 0.16)" },
  tan: { accent: "#c4a072", accentHover: "#d4b082", accentSoft: "rgba(196, 160, 114, 0.14)" },
};

export const ACCENT_IDS = Object.keys(ACCENTS);

export const radii = {
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "20px",
  pill: "999px",
} as const;

export const spacing = {
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "24px",
  xxl: "32px",
} as const;

export const typography = {
  fontSans: `"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
  fontMono: `"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace`,
  sizeXs: "12px",
  sizeSm: "13px",
  sizeMd: "14px",
  sizeLg: "16px",
  sizeXl: "20px",
} as const;

/** The terminal chrome needs the same colors in CSS as xterm gets in JS, so the
 * panel frame can never drift from the surface xterm paints inside it. */
function terminalLines(palette: { background: string; foreground: string; brightBlack: string }): string[] {
  return [
    `  --terminal-bg: ${palette.background};`,
    `  --terminal-fg: ${palette.foreground};`,
    `  --terminal-dim: ${palette.brightBlack};`,
  ];
}

function colorLines(palette: Record<string, string>): string[] {
  return Object.entries(palette).map(([k, v]) => `  --color-${kebab(k)}: ${v};`);
}

/** Emit tokens as CSS custom properties: shared metrics on :root, colors per theme. */
export function cssVariables(): string {
  const lines: string[] = [];

  lines.push(":root {");
  for (const [k, v] of Object.entries(radii)) lines.push(`  --radius-${kebab(k)}: ${v};`);
  for (const [k, v] of Object.entries(spacing)) lines.push(`  --space-${kebab(k)}: ${v};`);
  lines.push(`  --font-sans: ${typography.fontSans};`);
  lines.push(`  --font-mono: ${typography.fontMono};`);
  lines.push("}");

  // Dark is the default (applies with no attribute as well).
  lines.push(':root, :root[data-theme="dark"] {');
  lines.push("  color-scheme: dark;");
  lines.push(...colorLines(colors));
  lines.push(...terminalLines(terminalDark));
  lines.push("}");

  lines.push(':root[data-theme="light"] {');
  lines.push("  color-scheme: light;");
  lines.push(...colorLines(colorsLight));
  lines.push(...terminalLines(terminalLight));
  lines.push("}");

  lines.push(':root[data-theme="warm"] {');
  lines.push("  color-scheme: dark;");
  lines.push(...colorLines(colorsWarm));
  lines.push(...terminalLines(terminalDark));
  lines.push("}");

  lines.push(':root[data-theme="obsidian"] {');
  lines.push("  color-scheme: dark;");
  lines.push(...colorLines(colorsObsidian));
  lines.push(...terminalLines(terminalObsidian));
  lines.push("}");

  // Reference style family: a reverse-engineered design language (neutral ramp,
  // blue-400 accent, alpha-light borders, stacked-ring elevation). Opt-in only;
  // Deyin's own palettes above stay the default.
  lines.push(':root[data-theme="reference"], :root[data-color-scheme="reference"] {');
  lines.push("  color-scheme: dark;");
  lines.push(...colorLines(refStyleDark));
  lines.push(...terminalLines(terminalRefStyle));
  lines.push(`  --elevation-raised: ${refElevation.raised};`);
  lines.push(`  --elevation-floating: ${refElevation.floating};`);
  lines.push(`  --elevation-overlay: ${refElevation.overlay};`);
  lines.push(`  --elevation-input: ${refElevation.input};`);
  lines.push(`  --line-height-tight: ${refLineHeights.tight};`);
  lines.push(`  --line-height-compact: ${refLineHeights.compact};`);
  lines.push(`  --line-height-base: ${refLineHeights.base};`);
  lines.push("}");
  for (const [hue, pair] of Object.entries(refAvatars)) {
    lines.push(`:root[data-theme="reference"], :root[data-color-scheme="reference"] {`);
    lines.push(`  --avatar-bg-${hue}: ${pair.bg};`);
    lines.push(`  --avatar-border-${hue}: ${pair.border};`);
    lines.push("}");
  }
  lines.push(':root[data-theme="reference"], :root[data-color-scheme="reference"] {');
  lines.push(`  --agent-plan: ${refAgentColors.plan};`);
  lines.push(`  --agent-plan-border: ${refAgentColors.planBorder};`);
  lines.push(`  --agent-plan-bg: ${refAgentColors.planBackground};`);
  lines.push(`  --agent-build: ${refAgentColors.build};`);
  lines.push(`  --agent-build-border: ${refAgentColors.buildBorder};`);
  lines.push(`  --agent-build-bg: ${refAgentColors.buildBackground};`);
  lines.push(`  --agent-explore: ${refAgentColors.explore};`);
  lines.push(`  --agent-explore-border: ${refAgentColors.exploreBorder};`);
  lines.push(`  --agent-explore-bg: ${refAgentColors.exploreBackground};`);
  lines.push(`  --agent-review: ${refAgentColors.review};`);
  lines.push(`  --agent-writer: ${refAgentColors.writer};`);
  lines.push("}");

  for (const [id, tokens] of Object.entries(ACCENTS)) {
    lines.push(`:root[data-accent="${id}"] {`);
    lines.push(`  --color-accent: ${tokens.accent};`);
    lines.push(`  --color-accent-hover: ${tokens.accentHover};`);
    lines.push(`  --color-accent-soft: ${tokens.accentSoft};`);
    lines.push("}");
  }
  // The default blue accent needs its darker step
  // on the light interface to keep contrast.
  lines.push(':root[data-theme="light"][data-accent="blue"] {');
  lines.push(`  --color-accent: ${colorsLight.accent};`);
  lines.push(`  --color-accent-hover: ${colorsLight.accentHover};`);
  lines.push(`  --color-accent-soft: ${colorsLight.accentSoft};`);
  lines.push("}");

  return lines.join("\n");
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** ANSI + chrome colors for the integrated terminal (xterm `ITheme` shape).
 *
 * xterm's stock palette is the raw VGA one (pure #00ff00 green, #0000ff blue);
 * against Deyin's flat greys it glares and reads as a foreign window. These are
 * desaturated, luminance-matched ramps: each bright pair sits one step above its
 * normal, and every hue clears ~4.5:1 against its own background so shell
 * prompts, `ls` output and diffs stay legible without turning neon.
 */
export const terminalDark = {
  background: "#151517",
  foreground: "#dcdcdc",
  cursor: colors.accent,
  cursorAccent: "#151517",
  selectionBackground: "rgba(122, 170, 255, 0.30)",
  selectionInactiveBackground: "rgba(255, 255, 255, 0.10)",

  black: "#3a3a3a",
  red: "#e06c78",
  green: "#63cc8e",
  yellow: "#d9b25f",
  blue: "#5aa9ef",
  magenta: "#c48ce6",
  cyan: "#4fc3d1",
  white: "#c9cbcd",

  brightBlack: "#6e7276",
  brightRed: "#f58a94",
  brightGreen: "#84e0a8",
  brightYellow: "#efc97f",
  brightBlue: "#82c3ff",
  brightMagenta: "#d9adf5",
  brightCyan: "#72dbe8",
  brightWhite: "#f3f4f5",
} as const;

/** Light-theme counterpart: same hues, inverted luminance so they hold on paper. */
export const terminalLight = {
  background: "#ffffff",
  foreground: "#26262a",
  cursor: colorsLight.accent,
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(63, 102, 224, 0.20)",
  selectionInactiveBackground: "rgba(0, 0, 0, 0.08)",

  black: "#2b2b2f",
  red: "#c1372f",
  green: "#1e7a45",
  yellow: "#8a6100",
  blue: "#2f55d4",
  magenta: "#8b3fbe",
  cyan: "#0d6f7d",
  white: "#a8a8a4",

  brightBlack: "#65656b",
  brightRed: "#d8483c",
  brightGreen: "#2a9455",
  brightYellow: "#a4780b",
  brightBlue: "#3f66e0",
  brightMagenta: "#a253d8",
  brightCyan: "#12889a",
  brightWhite: "#3a3a3e",
} as const;

export const terminalObsidian = {
  background: "#0d0e11",
  foreground: "#e2e8f0",
  cursor: "#38bdf8",
  cursorAccent: "#0d0e11",
  selectionBackground: "rgba(56, 189, 248, 0.28)",
  selectionInactiveBackground: "rgba(255, 255, 255, 0.08)",

  black: "#1e293b",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#38bdf8",
  white: "#e2e8f0",

  brightBlack: "#475569",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#e9d5ff",
  brightCyan: "#7dd3fc",
  brightWhite: "#f8fafc",
} as const;

/** Terminal colors for an interface theme variant. */
export function terminalTheme(variant: "light" | "dark" | "obsidian") {
  if (variant === "light") return terminalLight;
  if (variant === "obsidian") return terminalObsidian;
  return terminalDark;
}
