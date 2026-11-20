import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computerUseConfirmationRequired,
  computerUsePermissionRules,
  computerUseRiskLevel,
  isDestructiveChord,
  normalizeChord,
} from "../src/computer-use-confirmations.js";

const needs = (toolName: string, args: Record<string, unknown> = {}) => computerUseConfirmationRequired({ toolName, args });

test("normalizeChord resolves aliases, case and spacing, and orders modifiers", () => {
  assert.equal(normalizeChord("Ctrl + Shift + T"), "ctrl+shift+t");
  assert.equal(normalizeChord("shift+control+t"), "ctrl+shift+t");
  assert.equal(normalizeChord("control+alt+del"), "ctrl+alt+delete");
  assert.equal(normalizeChord("Esc"), "escape");
  assert.equal(normalizeChord("cmd+r"), "win+r");
  assert.equal(normalizeChord("F5"), "f5");
});

test("the last part is the key even when it is named like a modifier", () => {
  assert.equal(normalizeChord("shift"), "shift");
  assert.equal(normalizeChord("ctrl+shift"), "ctrl+shift");
});

test("destructive chords are recognised however they are written", () => {
  for (const chord of ["alt+f4", "Alt + F4", "ctrl+w", "CTRL+W", "ctrl+shift+w", "ctrl+f4", "shift+delete", "ctrl+shift+delete", "control+alt+del"]) {
    assert.equal(isDestructiveChord(chord), true, chord);
  }
});

test("any chord that uses the Windows key leaves the app and needs confirmation", () => {
  for (const chord of ["win+r", "win+d", "windows+x", "ctrl+win+left", "meta+l"]) {
    assert.equal(isDestructiveChord(chord), true, chord);
  }
});

test("ordinary keys and chords do not", () => {
  for (const chord of ["enter", "tab", "escape", "f5", "ctrl+a", "ctrl+c", "ctrl+t", "alt+left", "delete", "win"]) {
    assert.equal(isDestructiveChord(chord), false, chord);
  }
});

test("pressing a destructive chord requires confirmation; an ordinary key does not", () => {
  assert.equal(needs("computer_press_key", { key: "alt+f4" }), true);
  assert.equal(needs("computer_press_key", { key: "win+r" }), true);
  assert.equal(needs("computer_press_key", { key: "enter" }), false);
  assert.equal(needs("computer_press_key", { key: "ctrl+a" }), false);
});

test("right and middle clicks require confirmation; left clicks do not", () => {
  assert.equal(needs("computer_click", { ref: "s1e2", button: "right" }), true);
  assert.equal(needs("computer_click", { ref: "s1e2", button: "middle" }), true);
  assert.equal(needs("computer_click", { ref: "s1e2", button: "left" }), false);
  assert.equal(needs("computer_click", { ref: "s1e2" }), false);
  assert.equal(needs("computer_click", { x: 10, y: 20, count: 2 }), false);
});

test("launching an app always requires confirmation", () => {
  assert.equal(needs("computer_launch_app", { app_id: "notepad" }), true);
});

test("typing text that commits something, or a lot of text, requires confirmation", () => {
  assert.equal(needs("computer_type", { text: "hello" }), false);
  assert.equal(needs("computer_type", { text: "please delete my account" }), true);
  assert.equal(needs("computer_type", { text: "x".repeat(81) }), true);
  assert.equal(needs("computer_set_value", { ref: "s1e3", value: "my password is hunter2" }), true);
  assert.equal(needs("computer_set_value", { ref: "s1e3", value: "a title" }), false);
});

test("observing and waiting never require confirmation", () => {
  for (const tool of ["computer_list_apps", "computer_list_windows", "computer_list_displays", "computer_get_state", "computer_wait"]) {
    assert.equal(needs(tool, { text: "delete" }), false, tool);
  }
});

test("risk levels follow the same rules", () => {
  assert.equal(computerUseRiskLevel({ toolName: "computer_press_key", args: { key: "alt+f4" } }), "high");
  assert.equal(computerUseRiskLevel({ toolName: "computer_click", args: { ref: "a" } }), "medium");
  assert.equal(computerUseRiskLevel({ toolName: "computer_hover", args: { ref: "a" } }), "medium");
  assert.equal(computerUseRiskLevel({ toolName: "computer_get_state", args: {} }), "low");
});

test("permission rules allow observation and ask for every action", () => {
  const rules = new Map(computerUsePermissionRules().map((r) => [r.tool, r.action]));
  for (const tool of ["computer_list_apps", "computer_list_windows", "computer_list_displays", "computer_get_state", "computer_wait"]) {
    assert.equal(rules.get(tool), "allow", tool);
  }
  for (const tool of ["computer_launch_app", "computer_click", "computer_hover", "computer_type", "computer_press_key", "computer_scroll", "computer_drag", "computer_set_value"]) {
    assert.equal(rules.get(tool), "ask", tool);
  }
});
