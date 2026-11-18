/** Client-side `/mode` commands: the composer's mode switch typed instead of clicked.
 *
 * The composer used to carry an "Agent" chip whose dropdown listed every mode.
 * Modes are now written the same way goals are — `/plan`, `/ask`, `/bot",
 * `/agent`` — so the only thing in the tool row is the access chip that actually
 * needs a menu. `/plan <task>` switches mode *and* runs `<task>` in it; a bare
 * `/plan` only switches, so the next message is composed in that mode.
 */
import type { ChatMode } from "@deyin/contract";

/** Modes a slash command can select. Delivery stays out: it is not offered today. */
export const MODE_COMMAND_NAMES = ["agent", "plan", "ask", "bot"] as const;

export type ModeCommandName = (typeof MODE_COMMAND_NAMES)[number];

export interface ModeCommand {
  mode: ChatMode;
  /** Text after the command, sent as the prompt in that mode. Empty for a bare switch. */
  prompt: string;
}

const MODE_BY_NAME: Record<ModeCommandName, ChatMode> = {
  agent: "agent",
  plan: "plan",
  ask: "ask",
  bot: "bot",
};

/** True when `name` is one of the composer's mode commands. */
export function isModeCommandName(name: string): name is ModeCommandName {
  return (MODE_COMMAND_NAMES as readonly string[]).includes(name);
}

/**
 * Parse a composer line as a mode command.
 *
 * Returns null when the line is not one, so the caller sends it as an ordinary
 * message. The name must be followed by whitespace or end of input, which is
 * what keeps `/planning.md` or an absolute path from matching `/plan`.
 */
export function parseModeCommand(text: string): ModeCommand | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  if (!isModeCommandName(name)) return null;
  return { mode: MODE_BY_NAME[name], prompt: (match[2] ?? "").trim() };
}

/** One-line hint under the composer while it holds a mode command. */
export function modeCommandHint(value: string): string | null {
  const parsed = parseModeCommand(value);
  if (!parsed) return null;
  const name = parsed.mode;
  if (parsed.prompt.length > 0) {
    return `Sends this in ${name} mode.`;
  }
  return `Switches to ${name} mode. Type after the command to start in it.`;
}
