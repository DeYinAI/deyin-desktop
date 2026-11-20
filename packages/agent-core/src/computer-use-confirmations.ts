/**
 * Confirmation taxonomy for computer_use tools.
 * Maps tool + args to whether user confirmation is required beyond tier defaults.
 */
export type ComputerUseRisk = "low" | "medium" | "high";

export interface ComputerUseActionContext {
  toolName: string;
  args: Record<string, unknown>;
}

const HIGH_RISK_TOOLS = new Set(["computer_launch_app", "computer_type", "computer_drag"]);
const MEDIUM_RISK_TOOLS = new Set([
  "computer_click",
  "computer_hover",
  "computer_press_key",
  "computer_scroll",
  "computer_set_value",
]);

/** Words in what is typed, set or dragged that suggest the action commits something. */
const HIGH_RISK_KEYWORDS = /purchase|buy|pay|delete|remove|send|submit|confirm|login|sign.?in|password/i;

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "win"] as const;

const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  win: "win",
  windows: "win",
  meta: "win",
  super: "win",
  cmd: "win",
  command: "win",
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  del: "delete",
  return: "enter",
};

/**
 * Chords that close a window or tab, remove things for good, or leave the app. A single stray one can lose the
 * user's work, so they are confirmed even when pressing keys is otherwise allowed.
 */
const DESTRUCTIVE_CHORDS = new Set([
  "alt+f4",
  "ctrl+w",
  "ctrl+f4",
  "ctrl+shift+w",
  "ctrl+alt+delete",
  "ctrl+shift+delete",
  "shift+delete",
]);

/** `Ctrl + Shift + T` → `ctrl+shift+t`: aliases resolved, modifiers in a fixed order. */
export function normalizeChord(chord: string): string {
  const parts = chord
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  const modifiers = new Set<(typeof MODIFIER_ORDER)[number]>();
  const keys: string[] = [];
  parts.forEach((part, index) => {
    const modifier = MODIFIER_ALIASES[part];
    // The last part is always the key, even if it is named like a modifier (`ctrl+shift` presses shift).
    if (modifier && index < parts.length - 1) modifiers.add(modifier);
    else keys.push(KEY_ALIASES[part] ?? part);
  });
  return [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), ...keys].join("+");
}

/** True for chords that destroy work or leave the app (see DESTRUCTIVE_CHORDS), or use the Windows key. */
export function isDestructiveChord(chord: string): boolean {
  const normalized = normalizeChord(chord);
  if (DESTRUCTIVE_CHORDS.has(normalized)) return true;
  return normalized.split("+").slice(0, -1).includes("win");
}

export function computerUseConfirmationRequired(ctx: ComputerUseActionContext): boolean {
  const { toolName, args } = ctx;
  if (toolName === "computer_launch_app") return true;
  if (toolName === "computer_press_key" && isDestructiveChord(String(args.key ?? ""))) return true;
  // A right or middle click opens context menus and can close tabs; the target is not visible in the arguments.
  if (toolName === "computer_click") {
    const button = String(args.button ?? "left");
    if (button === "right" || button === "middle") return true;
  }
  if (HIGH_RISK_TOOLS.has(toolName) || toolName === "computer_set_value") {
    const text = JSON.stringify(args);
    if (HIGH_RISK_KEYWORDS.test(text)) return true;
    if (toolName === "computer_type" && String(args.text ?? "").length > 80) return true;
  }
  return false;
}

export function computerUseRiskLevel(ctx: ComputerUseActionContext): ComputerUseRisk {
  if (computerUseConfirmationRequired(ctx)) return "high";
  if (MEDIUM_RISK_TOOLS.has(ctx.toolName) || HIGH_RISK_TOOLS.has(ctx.toolName)) return "medium";
  return "low";
}

export function computerUsePermissionRules(): Array<{ tool: string; action: "ask" | "allow" }> {
  return [
    { tool: "computer_list_apps", action: "allow" },
    { tool: "computer_list_windows", action: "allow" },
    { tool: "computer_list_displays", action: "allow" },
    { tool: "computer_get_state", action: "allow" },
    { tool: "computer_wait", action: "allow" },
    { tool: "computer_launch_app", action: "ask" },
    { tool: "computer_click", action: "ask" },
    { tool: "computer_hover", action: "ask" },
    { tool: "computer_type", action: "ask" },
    { tool: "computer_press_key", action: "ask" },
    { tool: "computer_scroll", action: "ask" },
    { tool: "computer_drag", action: "ask" },
    { tool: "computer_set_value", action: "ask" },
  ];
}
