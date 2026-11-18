/**
 * Style-family tokens ported from a reverse-engineered reference IDE.
 *
 * The reference ships a 12-step hue ramp per colour plus a semantic layer
 * (background / text / icon / border / overlay / state / agent / avatar /
 * elevation). Nothing here is Deyin's own palette — it is an optional
 * "reference" style that reproduces that design language, so Deyin's brand
 * colours stay the default and this can be switched on per user.
 *
 * Every value below was read out of the reference's own CSS token files, not
 * eyeballed from screenshots.
 */

/** 12-step neutral ramp, cool-neutral, the reference's primary greyscale. */
export const refGrey = {
  50: "#ffffff",
  100: "#fafafa",
  200: "#f2f2f2",
  300: "#eeeeee",
  400: "#dbdbdb",
  500: "#aeaeae",
  600: "#808080",
  700: "#5c5c5c",
  800: "#3a3a3a",
  900: "#2e2e2e",
  1000: "#242424",
  1100: "#161616",
  1200: "#080808",
} as const;

/** Accent ramp used for focus, links and the active state. */
export const refBlue = {
  100: "#f5f8ff",
  200: "#ecf1fe",
  300: "#c3d4fd",
  400: "#a2bcff",
  500: "#7698fd",
  600: "#3b5cf6",
  700: "#0b34f4",
  800: "#3250df",
  900: "#2c47c8",
  1000: "#263fa9",
  1100: "#22388f",
  1200: "#021945",
} as const;

export const refGreen = {
  300: "#b8e9c1",
  500: "#6bd586",
  800: "#198b43",
  900: "#1d783c",
  1200: "#14361d",
} as const;

export const refYellow = {
  300: "#f7e5b5",
  400: "#f3da9b",
  500: "#f2cf76",
  800: "#cb9f34",
  900: "#ac8833",
  1200: "#4b4025",
} as const;

export const refRed = {
  300: "#f2bbb7",
  500: "#f17471",
  800: "#b82d35",
  900: "#97252b",
  1200: "#461516",
} as const;

export const refPink = { 400: "#f799c6" } as const;
export const refPurple = { 400: "#9e99f7" } as const;
export const refCyan = { 1200: "#00353f" } as const;

/** Fixed project-avatar pairs (dark-mode variants), keyed by hue. */
export const refAvatars = {
  orange: { bg: "#723d22", border: "#ff8648" },
  yellow: { bg: "#68552b", border: "#e7af36" },
  cyan: { bg: "#005a6e", border: "#0096b8" },
  green: { bg: "#196130", border: "#49c970" },
  red: { bg: "#7a1f23", border: "#d92e3c" },
  pink: { bg: "#8c2d61", border: "#e4429e" },
  blue: { bg: "#263fa9", border: "#7698fd" },
  purple: { bg: "#361f83", border: "#7152f4" },
  gray: { bg: "#5c5c5c", border: "#aeaeae" },
} as const;

export type RefAvatarHue = keyof typeof refAvatars;

/**
 * Semantic dark-mode theme: the values the reference actually applies when
 * `data-color-scheme="dark"`. Deyin components read these through the same
 * `--color-*` names they already use, so switching the style needs no component
 * changes.
 */
export const refStyleDark = {
  // Background layers, shallow → deep
  bg: refGrey[1100],
  surface: refGrey[1000],
  surfaceRaised: refGrey[900],
  surfaceOverlay: refGrey[800],
  // Borders are alpha-light so they read on any layer
  border: "rgba(255, 255, 255, 0.10)",
  borderStrong: "rgba(255, 255, 255, 0.20)",
  hairline: "rgba(255, 255, 255, 0.08)",
  // Text
  text: refGrey[100],
  textMuted: refGrey[500],
  textFaint: refGrey[600],
  // Accent — blue-400 in dark mode, exactly as the reference resolves it
  accent: refBlue[400],
  accentHover: refBlue[300],
  accentSoft: "rgba(162, 188, 255, 0.10)",
  /**
   * The reference has no separate "warm" accent: its nav and feature icons are
   * plain muted text that brighten on hover. Mapping this to the muted grey is
   * what makes the rail read neutral instead of gold.
   */
  accentWarm: refGrey[400],
  // Primary button is a light chip on dark, like the reference's neutral button
  sendBg: refGrey[100],
  sendFg: refGrey[1100],
  // State
  success: refGreen[500],
  warning: refYellow[500],
  danger: refRed[500],
  running: refBlue[400],
} as const;

/** Agent mode colours, used for mode pills and status marks. */
export const refAgentColors = {
  plan: refPink[400],
  planBorder: "rgba(247, 153, 198, 0.2)",
  planBackground: "rgba(170, 53, 118, 0.05)",
  build: refBlue[300],
  buildBorder: "rgba(162, 188, 255, 0.2)",
  buildBackground: "rgba(38, 63, 169, 0.05)",
  explore: refYellow[300],
  exploreBorder: "rgba(243, 218, 155, 0.2)",
  exploreBackground: "rgba(172, 136, 51, 0.05)",
  review: refGreen[300],
  writer: refPurple[400],
} as const;

/**
 * Elevation recipes. The reference builds depth from stacked alpha rings rather
 * than a single drop shadow, which is why their cards read as crisp hairlines
 * instead of soft glows.
 */
export const refElevation = {
  raised:
    "0px 2px 4px 0px rgba(0,0,0,0.19), 0px 1px 2px 0px rgba(0,0,0,0.19), 0px 0px 0px 0.5px rgba(255,255,255,0.06), 0px -0.5px 0px 0px rgba(255,255,255,0.02)",
  floating:
    "0px 8px 16px 0px rgba(0,0,0,0.19), 0px 4px 8px 0px rgba(0,0,0,0.19), 0px 0px 0px 0.5px rgba(255,255,255,0.06), 0px -0.5px 0px 0px rgba(255,255,255,0.02)",
  overlay:
    "0px 16px 32px 0px rgba(0,0,0,0.19), 0px 8px 16px 0px rgba(0,0,0,0.19), 0px 0px 0px 0.5px rgba(255,255,255,0.06), 0px -0.5px 0px 0px rgba(255,255,255,0.02)",
  input:
    "0px 1px 2px 0px rgba(0,0,0,0), 0px 0px 0px 0.5px rgba(255,255,255,0.06), 0px -0.5px 0px 0px rgba(255,255,255,0.02)",
  elements: "0px 0.5px 0.5px 0px rgba(0,0,0,0.25)",
} as const;

/** Line heights from the reference's token file. */
export const refLineHeights = {
  tight: "12px",
  compact: "16px",
  base: "20px",
} as const;

/** Terminal palette matching the reference's dark background and accent. */
export const terminalRefStyle = {
  background: refGrey[1100],
  foreground: refGrey[200] ?? "#f2f2f2",
  cursor: refBlue[400],
  cursorAccent: refGrey[1100],
  selectionBackground: "rgba(118, 152, 253, 0.28)",
  selectionInactiveBackground: "rgba(255, 255, 255, 0.08)",
  black: refGrey[800],
  red: refRed[500],
  green: refGreen[500],
  yellow: refYellow[500],
  blue: refBlue[400],
  magenta: refPink[400],
  cyan: "#65d9eb",
  white: refGrey[300],
  brightBlack: refGrey[700],
  brightRed: "#f29b96",
  brightGreen: refGreen[300],
  brightYellow: refYellow[300],
  brightBlue: refBlue[300],
  brightMagenta: "#e9d5ff",
  brightCyan: "#a3e4ef",
  brightWhite: refGrey[100],
} as const;
