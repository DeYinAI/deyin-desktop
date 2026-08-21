/** Deyin design tokens. Original values; a soft, rounded, card-based aesthetic
 * with dark and light interface themes. */

export const brand = {
  name: "Deyin",
  tagline: "Agentic development, with Openference.",
} as const;

/** Dark theme palette (default). Mirrors the legacy UI dark palette: Tailwind v4
 * neutrals for surfaces and text, sky for the accent, alpha-based borders. */
export const colors = {
  // Surfaces. Flat editor-grade greys: the window/sidebar ground sits a shade
  // below the content card, so the card reads as raised without a hard border.
  bg: "#181818",
  surface: "#1f1f1f",
  surfaceRaised: "#2a2a2a",
  surfaceOverlay: "#252525",
  border: "rgba(255, 255, 255, 0.075)",
  borderStrong: "rgba(255, 255, 255, 0.22)",
  /** Ultra-subtle internal separator (rows inside cards). */
  hairline: "rgba(255, 255, 255, 0.05)",

  // Text (neutral-200, alpha steps for muted/faint as in legacy UI)
  text: "#e0e0e0",
  textMuted: "rgba(224, 224, 224, 0.62)",
  textFaint: "rgba(224, 224, 224, 0.34)",

  // Accent (legacy UI brand: sky-500/sky-400, soft fill from sky-950)
  accent: "#00a5ea",
  accentHover: "#00bbfd",
  accentSoft: "#052f4a80",
  /** Warm counter-accent: the "new chat" mark and other create affordances. */
  accentWarm: "#e2a45c",

  // Send button (legacy UI primary: neutral-50 fill, neutral-950 text)
  sendBg: "#fafafa",
  sendFg: "#0a0a0a",

  // Status
  success: "#00c65a",
  warning: "#eab300",
  danger: "#fb2c36",
  running: "#00a5ea",
} as const;

/** Light theme palette. */
export const colorsLight = {
  bg: "#f4f4f3",
  surface: "#ffffff",
  surfaceRaised: "#f0f0ef",
  surfaceOverlay: "#ffffff",
  border: "#e5e5e3",
  borderStrong: "#d4d4d1",
  hairline: "rgba(0, 0, 0, 0.065)",

  text: "#1e1e1d",
  textMuted: "#6a6a67",
  textFaint: "#9a9a96",

  accent: "#3f66e0",
  accentHover: "#2f55d4",
  accentSoft: "rgba(63, 102, 224, 0.12)",
  accentWarm: "#b4690e",

  sendBg: "#1f1f1e",
  sendFg: "#ffffff",

  success: "#1a7f37",
  warning: "#9a6700",
  danger: "#cf222e",
  running: "#3f66e0",
} as const;

export const radii = {
  sm: "8px",
  md: "10px",
  lg: "14px",
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
  background: "#141414",
  foreground: "#dcdcdc",
  cursor: colors.accent,
  cursorAccent: "#141414",
  selectionBackground: "rgba(0, 165, 234, 0.30)",
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

/** Terminal colors for an interface theme variant. */
export function terminalTheme(variant: "light" | "dark") {
  return variant === "light" ? terminalLight : terminalDark;
}
