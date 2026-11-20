import assert from "node:assert/strict";
import test from "node:test";
import { isModeCommandName, modeCommandHint, parseModeCommand } from "../src/modeCommand.js";

test("parseModeCommand: bare command switches without a prompt", () => {
  assert.deepEqual(parseModeCommand("/plan"), { mode: "plan", prompt: "" });
  assert.deepEqual(parseModeCommand("/ask"), { mode: "ask", prompt: "" });
  assert.deepEqual(parseModeCommand("/agent"), { mode: "agent", prompt: "" });
  assert.deepEqual(parseModeCommand("/conductor"), { mode: "conductor", prompt: "" });
  // `/bot` is the old name for Conductor mode and keeps working as an alias.
  assert.deepEqual(parseModeCommand("/bot"), { mode: "conductor", prompt: "" });
  assert.deepEqual(parseModeCommand("/conductor Claude plans, ZCode builds"), {
    mode: "conductor",
    prompt: "Claude plans, ZCode builds",
  });
});

test("parseModeCommand: command with text carries the prompt", () => {
  assert.deepEqual(parseModeCommand("/plan audit the auth flow"), {
    mode: "plan",
    prompt: "audit the auth flow",
  });
  // Multi-line prompts survive; only the command word is split off.
  assert.deepEqual(parseModeCommand("/ask what is this?\nand this?"), {
    mode: "ask",
    prompt: "what is this?\nand this?",
  });
});

test("parseModeCommand: surrounds, case and extra spaces are tolerated", () => {
  assert.deepEqual(parseModeCommand("  /plan   map the router  "), {
    mode: "plan",
    prompt: "map the router",
  });
  assert.deepEqual(parseModeCommand("/PLAN"), { mode: "plan", prompt: "" });
});

test("parseModeCommand: non-commands return null", () => {
  assert.equal(parseModeCommand("plan the migration"), null);
  assert.equal(parseModeCommand("/planning.md is a file"), null);
  assert.equal(parseModeCommand("/home/me/notes.md"), null);
  assert.equal(parseModeCommand("/goal ship it"), null);
  assert.equal(parseModeCommand("/delivery"), null);
  assert.equal(parseModeCommand(""), null);
});

test("isModeCommandName: only the selectable modes and the /bot alias", () => {
  for (const name of ["agent", "plan", "ask", "conductor", "bot"]) {
    assert.equal(isModeCommandName(name), true, name);
  }
  for (const name of ["delivery", "goal", "commit", ""]) {
    assert.equal(isModeCommandName(name), false, name);
  }
});

test("modeCommandHint: explains both forms and stays quiet otherwise", () => {
  assert.match(modeCommandHint("/plan") ?? "", /Switches to plan mode/);
  assert.match(modeCommandHint("/plan audit the auth flow") ?? "", /Sends this in plan mode/);
  assert.match(modeCommandHint("/conductor") ?? "", /Switches to conductor mode/);
  assert.match(modeCommandHint("/bot do it") ?? "", /Sends this in conductor mode/);
  assert.equal(modeCommandHint("hello"), null);
  assert.equal(modeCommandHint("/goal ship it"), null);
});
