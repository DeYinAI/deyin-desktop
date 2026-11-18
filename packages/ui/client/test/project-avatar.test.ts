import assert from "node:assert/strict";
import test from "node:test";
import { refAvatars, type RefAvatarHue } from "@deyin/branding";
import { avatarHueFor, avatarInitial } from "../src/components/ProjectAvatar.js";

test("avatarHueFor is deterministic for the same project", () => {
  const first = avatarHueFor("proj-abc");
  for (let i = 0; i < 20; i += 1) assert.equal(avatarHueFor("proj-abc"), first);
});

test("avatarHueFor always returns a hue the palette defines", () => {
  const valid = new Set(Object.keys(refAvatars));
  for (const seed of ["a", "proj-1", "", "workspace", "ünïcødé", "x".repeat(200)]) {
    const hue: RefAvatarHue = avatarHueFor(seed);
    assert.ok(valid.has(hue), `hue ${hue} must exist in refAvatars`);
  }
});

test("avatarHueFor spreads distinct projects across more than one hue", () => {
  const hues = new Set(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"].map(avatarHueFor));
  assert.ok(hues.size > 1, "eight distinct projects must not all share one colour");
});

test("avatarInitial takes the first alphanumeric and uppercases it", () => {
  assert.equal(avatarInitial("deyin-desktop"), "D");
  assert.equal(avatarInitial("  my project"), "M");
  assert.equal(avatarInitial("_under"), "U");
  assert.equal(avatarInitial("9lives"), "9");
});

test("avatarInitial falls back to a dot for names with nothing alphanumeric", () => {
  assert.equal(avatarInitial(""), "•");
  assert.equal(avatarInitial("---"), "•");
  assert.equal(avatarInitial("   "), "•");
});

test("every avatar hue defines both a background and a border", () => {
  for (const [hue, pair] of Object.entries(refAvatars)) {
    assert.match(pair.bg, /^#[0-9a-f]{6}$/i, `${hue} bg must be a hex colour`);
    assert.match(pair.border, /^#[0-9a-f]{6}$/i, `${hue} border must be a hex colour`);
    assert.notEqual(pair.bg.toLowerCase(), pair.border.toLowerCase(), `${hue} bg and border must differ`);
  }
});
