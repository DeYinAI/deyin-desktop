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
  lines.push("}");

  lines.push(':root[data-theme="light"] {');
  lines.push("  color-scheme: light;");
  lines.push(...colorLines(colorsLight));
  lines.push("}");

  return lines.join("\n");
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
