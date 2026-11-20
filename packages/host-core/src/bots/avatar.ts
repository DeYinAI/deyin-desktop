/**
 * Bot avatars: Deyin's own design. A Bot is a form in a brand-tinted color with a small orbit mark at its center
 * (a core, a ring, and a dot that travels the ring), echoing the orbit dot in the Deyin logo. What the dot and core
 * are doing shows what the Bot is doing.
 *
 * The forms, the colors and the mark are original to Deyin. A Bot that has not been given an avatar gets a stable
 * default derived from its id, so it looks the same on every launch and across machines without storing anything.
 */

/**
 * Every form keeps a disc of radius 30 around the center of its 100x100 box inside its outline, so the mark
 * (which lives in that disc) always sits on the body and never on the page behind it.
 */
export const BOT_AVATAR_SHAPES = ["orb", "tile", "tilt", "pill", "lozenge", "hexagon", "octagon", "diamond", "petal", "bloom"] as const;

export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number];

/** The softer forms a default avatar is drawn from; the sharper ones are chosen on purpose. */
export const BOT_DEFAULT_SHAPE_POOL: readonly BotAvatarShape[] = ["orb", "tile", "tilt", "pill", "hexagon", "octagon", "petal", "bloom"];

/** Light, brand-tinted colors that sit well on the dark interface. The first is the Deyin mark's own tint. */
export const BOT_AVATAR_COLORS = [
  { id: "periwinkle", label: "Periwinkle", value: "#8FB4FF" },
  { id: "indigo", label: "Indigo", value: "#4F7CFF" },
  { id: "iris", label: "Iris", value: "#8B7BFF" },
  { id: "orchid", label: "Orchid", value: "#C77DFF" },
  { id: "rose", label: "Rose", value: "#FF7A9C" },
  { id: "coral", label: "Coral", value: "#FF8A65" },
  { id: "amber", label: "Amber", value: "#FFC26B" },
  { id: "lime", label: "Lime", value: "#A3E06B" },
  { id: "mint", label: "Mint", value: "#4FE0B0" },
  { id: "teal", label: "Teal", value: "#35C3D4" },
  { id: "slate", label: "Slate", value: "#8794A8" },
  { id: "ink", label: "Ink", value: "#2B3040" },
] as const;

export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number]["id"];

/** Colors a default avatar may take. Ink, the dark one, is only ever picked deliberately. */
const DEFAULT_COLOR_IDS: readonly BotAvatarColor[] = BOT_AVATAR_COLORS.filter((c) => c.id !== "ink").map((c) => c.id);

/**
 * What Bots saved before the redesign were given, and what each becomes now, so a Bot keeps a look close to the one
 * its owner chose. Only read when a stored avatar is not one of the current ones.
 */
const LEGACY_SHAPES: Readonly<Record<string, BotAvatarShape>> = {
  blob: "orb",
  pebble: "orb",
  bean: "petal",
  egg: "pill",
  squircle: "tile",
  tablet: "tile",
  capsule: "pill",
  cylinder: "pill",
  hex: "hexagon",
  gem: "diamond",
  crystal: "diamond",
  wedge: "petal",
  shield: "hexagon",
  dome: "petal",
  arch: "pill",
  cloud: "bloom",
  teardrop: "petal",
  leaf: "petal",
  square: "tile",
  sparkle: "bloom",
  clover: "bloom",
  flower: "bloom",
  heart: "bloom",
  house: "hexagon",
  star: "octagon",
};

const LEGACY_COLORS: Readonly<Record<string, BotAvatarColor>> = {
  black: "ink",
  brown: "coral",
  red: "rose",
  orange: "coral",
  yellow: "amber",
  green: "mint",
  cyan: "teal",
  blue: "indigo",
  violet: "iris",
  magenta: "orchid",
  gray: "slate",
};

export function isBotAvatarShape(value: unknown): value is BotAvatarShape {
  return typeof value === "string" && (BOT_AVATAR_SHAPES as readonly string[]).includes(value);
}

export function isBotAvatarColor(value: unknown): value is BotAvatarColor {
  return typeof value === "string" && BOT_AVATAR_COLORS.some((c) => c.id === value);
}

/** The CSS color of a palette id, or the first palette color for an unknown one. */
export function botAvatarColorValue(color: string): string {
  return (BOT_AVATAR_COLORS.find((c) => c.id === color) ?? BOT_AVATAR_COLORS[0]).value;
}

/** Near-black and white, the two colors the mark is drawn in. */
export const BOT_AVATAR_INK = "#10131a";
export const BOT_AVATAR_WHITE = "#ffffff";

function channel(hex: string, at: number): number {
  const c = parseInt(hex.slice(at, at + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` color. */
export function relativeLuminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG contrast ratio between two `#rrggbb` colors, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** The color the mark is drawn in on this body color: whichever of near-black and white reads better. */
export function botAvatarMarkValue(color: string): string {
  const fill = botAvatarColorValue(color);
  return contrastRatio(fill, BOT_AVATAR_WHITE) > contrastRatio(fill, BOT_AVATAR_INK) ? BOT_AVATAR_WHITE : BOT_AVATAR_INK;
}

/** FNV-1a over UTF-16 units, finished with an avalanche mix so near-identical ids spread out. */
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = Math.imul(h ^ (h >>> 16), 73244475);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export interface BotAvatarChoice {
  shape: BotAvatarShape;
  color: BotAvatarColor;
}

/** Stable default look for a Bot id: same id, same avatar, always. */
export function defaultBotAvatar(botId: string): BotAvatarChoice {
  return {
    shape: BOT_DEFAULT_SHAPE_POOL[hashString(`${botId}:shape`) % BOT_DEFAULT_SHAPE_POOL.length]!,
    color: DEFAULT_COLOR_IDS[hashString(`${botId}:color`) % DEFAULT_COLOR_IDS.length]!,
  };
}

function legacyOwn<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * The avatar to draw: a stored shape or color when it is current, its closest current equivalent when it is from
 * before the redesign, and the id-derived default for any that is missing or unknown (a hand-edited file, a palette
 * shrunk by an update).
 */
export function resolveBotAvatar(bot: { id: string; avatarShape?: unknown; avatarColor?: unknown }): BotAvatarChoice {
  const fallback = defaultBotAvatar(bot.id);
  return {
    shape: isBotAvatarShape(bot.avatarShape) ? bot.avatarShape : (legacyOwn(LEGACY_SHAPES, bot.avatarShape) ?? fallback.shape),
    color: isBotAvatarColor(bot.avatarColor) ? bot.avatarColor : (legacyOwn(LEGACY_COLORS, bot.avatarColor) ?? fallback.color),
  };
}

/**
 * What a Bot's avatar is doing, as lifecycle states.
 * The chat maps run status onto these; the avatar only has to draw them.
 */
export const BOT_AVATAR_STATES = ["idle", "thinking", "working", "waiting", "blocked", "finished", "failed", "sleeping"] as const;
export type BotAvatarState = (typeof BOT_AVATAR_STATES)[number];
