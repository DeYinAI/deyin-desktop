/**
 * A guard against shell commands that type or click on the screen.
 *
 * When the browser tool an unattended run was meant to use was refused, the agent reached its goal another way:
 * a PowerShell one-liner sending keystrokes to whatever window was in front, which bypassed every check the
 * task had. OS input synthesis has its own gated tools (`computer_*`); an unattended run may not do it
 * through the shell. This is a rail for a model improvising, not a security boundary — an encoded command
 * would pass — and the message says what to do instead.
 */

const INPUT_SYNTHESIS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\b(SendKeys|SendInput|keybd_event|mouse_event|SetCursorPos)\b/i, what: "Windows input APIs" },
  { pattern: /System\.Windows\.Forms|\buser32(\.dll)?\b/i, what: "Windows UI automation" },
  { pattern: /\b(AutoHotkey|autohotkey|nircmd|ahk)\b/i, what: "an input automation tool" },
  { pattern: /\b(xdotool|ydotool|dotool|wtype)\b/i, what: "an X11/Wayland input tool" },
  { pattern: /\bcliclick\b|osascript[^\n]*\b(keystroke|key code|click)\b/i, what: "macOS UI scripting" },
  { pattern: /\b(pyautogui|pynput|pywinauto|pydirectinput|autopy|robotjs|nut-js)\b/i, what: "a GUI automation library" },
  { pattern: /\badb\s+(-\S+\s+)*shell\s+input\b/i, what: "Android input" },
];

/** A message explaining the refusal when `command` would synthesize OS input; null when it is fine. */
export function shellInputRefusal(command: string): string | null {
  for (const { pattern, what } of INPUT_SYNTHESIS) {
    if (pattern.test(command)) {
      return `Refused: this command would type or click on the screen (${what}). An unattended run may not do that. Use the tools the task gave you; if you do not have the right ones, call automation_report with outcome blocked and blocker kind tool-missing.`;
    }
  }
  return null;
}
