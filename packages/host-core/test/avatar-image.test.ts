import assert from "node:assert/strict";
import test from "node:test";
import {
  AVATAR_GENERATED_BUDGET,
  AVATAR_IMAGE_PIXELS,
  AVATAR_PROMPT_LIMIT,
  BOT_LIMITS,
  avatarImagePrompt,
  avatarSide,
  checkAvatarPrompt,
  isBotAvatarUrl,
  squareCrop,
} from "../src/shared.js";

test("a description is one trimmed line, and an empty or non-text one is refused", () => {
  assert.deepEqual(checkAvatarPrompt("  a fox\n\nin   a scarf\t"), { ok: true, text: "a fox in a scarf" });
  for (const bad of ["", "   ", "\n\t", undefined, null, 5, {}]) {
    const result = checkAvatarPrompt(bad);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "Describe the picture you want.");
  }
});

test("the description limit is exact: 300 characters pass and 301 are refused", () => {
  assert.equal(AVATAR_PROMPT_LIMIT, 300);
  assert.equal(checkAvatarPrompt("a".repeat(300)).ok, true);
  const over = checkAvatarPrompt("a".repeat(301));
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.error, "Keep the description under 300 characters.");
});

test("control characters do not count toward the length once they are cleaned away", () => {
  assert.equal(checkAvatarPrompt(`${"a".repeat(300)}\u0000\u0007`).ok, true);
});

test("the request keeps the person's words first and asks for a square picture with no lettering", () => {
  const prompt = avatarImagePrompt("a friendly owl", "Hoot");
  assert.ok(prompt.startsWith("a friendly owl"));
  assert.match(prompt, /a profile picture for an AI assistant called "Hoot"/);
  assert.match(prompt, /square picture with one centered subject/);
  assert.match(prompt, /No text, letters, numbers or logos/);
});

test("the Bot's name is optional and cannot break out of its quotes", () => {
  assert.doesNotMatch(avatarImagePrompt("a fox"), /called/);
  assert.doesNotMatch(avatarImagePrompt("a fox", "   "), /called/);
  const prompt = avatarImagePrompt("a fox", 'Evil" and then "more');
  assert.match(prompt, /called "Evil and then more"/);
  assert.doesNotMatch(prompt, /\u201c|\u201d/);
  const curly = avatarImagePrompt("a fox", "Ann \u201cthe Bot\u201d");
  assert.match(curly, /called "Ann the Bot"/);
});

test("a picture is cut to its middle square", () => {
  assert.deepEqual(squareCrop(1024, 1024), { x: 0, y: 0, width: 1024, height: 1024 });
  assert.deepEqual(squareCrop(1200, 1000), { x: 100, y: 0, width: 1000, height: 1000 });
  assert.deepEqual(squareCrop(1000, 1200), { x: 0, y: 100, width: 1000, height: 1000 });
  assert.deepEqual(squareCrop(1001, 1000), { x: 0, y: 0, width: 1000, height: 1000 });
  assert.deepEqual(squareCrop(1000, 1001), { x: 0, y: 0, width: 1000, height: 1000 });
});

test("a picture is never made larger than it is, nor larger than the avatar size", () => {
  assert.equal(AVATAR_IMAGE_PIXELS, 256);
  assert.equal(avatarSide(1024), 256);
  assert.equal(avatarSide(257), 256);
  assert.equal(avatarSide(256), 256);
  assert.equal(avatarSide(255), 255);
  assert.equal(avatarSide(64), 64);
});

test("a made picture fits well inside what a Bot may hold", () => {
  assert.ok(AVATAR_GENERATED_BUDGET < BOT_LIMITS.avatarUrl);
  assert.equal(AVATAR_GENERATED_BUDGET, 120_000);
});

test("only a PNG, JPEG or WebP data URL within the limit is an avatar", () => {
  assert.equal(isBotAvatarUrl("data:image/png;base64,iVBORw0KGgo="), true);
  assert.equal(isBotAvatarUrl("data:image/jpeg;base64,/9j/4AAQ"), true);
  assert.equal(isBotAvatarUrl("data:image/webp;base64,UklGRg=="), true);
  assert.equal(isBotAvatarUrl("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.equal(isBotAvatarUrl("data:image/gif;base64,R0lGOD"), false);
  assert.equal(isBotAvatarUrl("https://example.com/a.png"), false);
  assert.equal(isBotAvatarUrl("data:image/png;base64,"), false);
  assert.equal(isBotAvatarUrl("data:image/png;base64,abc def"), false);
  assert.equal(isBotAvatarUrl(null), false);
  assert.equal(isBotAvatarUrl(7), false);
  const head = "data:image/png;base64,";
  assert.equal(isBotAvatarUrl(head + "A".repeat(BOT_LIMITS.avatarUrl - head.length)), true);
  assert.equal(isBotAvatarUrl(head + "A".repeat(BOT_LIMITS.avatarUrl - head.length + 1)), false);
});
