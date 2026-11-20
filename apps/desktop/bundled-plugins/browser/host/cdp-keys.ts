/**
 * Key definitions and chord parsing for CDP `Input.dispatchKeyEvent`.
 * Shared by the Chrome module and the in-app browser.
 */

export interface KeyDef {
  /** DOM `key` value. */
  key: string;
  /** DOM `code` value. */
  code: string;
  /** Windows virtual key code. */
  vk: number;
  /** Text the key inserts when pressed without ctrl/alt/meta. */
  text?: string;
}

export const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
type ModifierName = keyof typeof MODIFIER_BITS;

const MODIFIER_ALIASES: Record<string, ModifierName> = {
  alt: "alt",
  option: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  windows: "meta",
  super: "meta",
  shift: "shift",
};

const MODIFIER_KEYS: Record<ModifierName, KeyDef> = {
  alt: { key: "Alt", code: "AltLeft", vk: 18 },
  ctrl: { key: "Control", code: "ControlLeft", vk: 17 },
  meta: { key: "Meta", code: "MetaLeft", vk: 91 },
  shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
};

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  del: { key: "Delete", code: "Delete", vk: 46 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
};
for (let i = 1; i <= 12; i++) {
  NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };
}

const PUNCTUATION: Record<string, { code: string; vk: number }> = {
  "-": { code: "Minus", vk: 189 },
  "=": { code: "Equal", vk: 187 },
  "[": { code: "BracketLeft", vk: 219 },
  "]": { code: "BracketRight", vk: 221 },
  "\\": { code: "Backslash", vk: 220 },
  ";": { code: "Semicolon", vk: 186 },
  "'": { code: "Quote", vk: 222 },
  ",": { code: "Comma", vk: 188 },
  ".": { code: "Period", vk: 190 },
  "/": { code: "Slash", vk: 191 },
  "`": { code: "Backquote", vk: 192 },
};

export interface ParsedChord {
  /** Combined modifier bitmask for the CDP `modifiers` field. */
  modifiers: number;
  /** Modifier keys to press (in order) before the main key. */
  modifierKeys: KeyDef[];
  key: KeyDef;
  /** Editing commands CDP needs to apply ctrl/meta shortcuts (select all, copy...). */
  commands: string[];
}

/** Editing shortcuts the page does not run on its own from synthetic key events. */
const EDIT_COMMANDS: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  v: "paste",
  x: "cut",
  z: "undo",
  y: "redo",
};

function singleChar(ch: string): KeyDef {
  const upper = ch.toUpperCase();
  if (/^[a-z]$/i.test(ch)) {
    return { key: ch, code: `Key${upper}`, vk: upper.charCodeAt(0), text: ch };
  }
  if (/^[0-9]$/.test(ch)) {
    return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch };
  }
  const punct = PUNCTUATION[ch];
  if (punct) return { key: ch, code: punct.code, vk: punct.vk, text: ch };
  // Any other printable character: send it as text with no physical key.
  return { key: ch, code: "", vk: 0, text: ch };
}

/**
 * Parse "Enter", "Control+A", "ctrl+shift+k", "Shift+Tab", "a" into a chord.
 * Throws on an empty spec or an unknown multi-character key name.
 */
export function parseChord(spec: string): ParsedChord {
  const parts = spec.split("+").map((p) => p.trim());
  // "Control++" (a literal plus) leaves a trailing empty part; treat it as "+".
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.splice(parts.length - 2, 2, "+");
  const mainName = parts.pop();
  if (!mainName) throw new Error(`Empty key: "${spec}"`);

  let modifiers = 0;
  const modifierKeys: KeyDef[] = [];
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (!mod) throw new Error(`Unknown modifier "${part}" in "${spec}". Use ctrl, alt, shift or meta.`);
    if (modifiers & MODIFIER_BITS[mod]) continue;
    modifiers |= MODIFIER_BITS[mod];
    modifierKeys.push(MODIFIER_KEYS[mod]);
  }

  const named = NAMED_KEYS[mainName.toLowerCase()];
  let key: KeyDef;
  if (named) {
    key = named;
  } else if ([...mainName].length === 1) {
    key = singleChar(mainName);
    if (/^[a-z]$/i.test(mainName)) {
      // Browsers report the shifted form only while Shift is held, whatever case the caller wrote.
      const letter = modifiers & MODIFIER_BITS.shift ? mainName.toUpperCase() : mainName.toLowerCase();
      key = { ...key, key: letter, text: letter };
    }
  } else {
    throw new Error(`Unknown key "${mainName}". Examples: Enter, Escape, Tab, ArrowDown, F5, a, Control+A.`);
  }

  const commands: string[] = [];
  if (modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta)) {
    const command = EDIT_COMMANDS[mainName.toLowerCase()];
    if (command) commands.push(command);
  }
  return { modifiers, modifierKeys, key, commands };
}

/** Params for one `Input.dispatchKeyEvent` of a chord's main key. */
export function keyEventParams(
  chord: ParsedChord,
  type: "keyDown" | "rawKeyDown" | "keyUp",
): Record<string, unknown> {
  const { key, modifiers } = chord;
  const params: Record<string, unknown> = {
    type,
    modifiers,
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.vk,
    nativeVirtualKeyCode: key.vk,
  };
  const producesText = key.text !== undefined && !(modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.alt | MODIFIER_BITS.meta));
  if (type === "keyDown" && producesText) {
    params.text = key.text;
    params.unmodifiedText = key.text;
  }
  if (type !== "keyUp" && chord.commands.length > 0) params.commands = chord.commands;
  return params;
}

/** Params for a bare modifier key event. */
export function modifierEventParams(def: KeyDef, type: "rawKeyDown" | "keyUp", modifiers: number): Record<string, unknown> {
  return { type, modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk };
}
