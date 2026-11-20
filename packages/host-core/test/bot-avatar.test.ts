import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_INK,
  BOT_AVATAR_SHAPES,
  BOT_AVATAR_STATES,
  BOT_AVATAR_WHITE,
  BOT_DEFAULT_SHAPE_POOL,
  botAvatarColorValue,
  botAvatarMarkValue,
  contrastRatio,
  defaultBotAvatar,
  isBotAvatarColor,
  isBotAvatarShape,
  relativeLuminance,
  resolveBotAvatar,
} from "../src/bots/avatar.js";

test("the forms and colors are the designed set, each once", () => {
  assert.deepEqual([...BOT_AVATAR_SHAPES], ["orb", "tile", "tilt", "pill", "lozenge", "hexagon", "octagon", "diamond", "petal", "bloom"]);
  assert.equal(new Set(BOT_AVATAR_SHAPES).size, BOT_AVATAR_SHAPES.length);
  assert.equal(BOT_AVATAR_COLORS.length, 12);
  assert.equal(new Set(BOT_AVATAR_COLORS.map((c) => c.id)).size, 12);
  assert.equal(new Set(BOT_AVATAR_COLORS.map((c) => c.value)).size, 12);
  for (const color of BOT_AVATAR_COLORS) assert.match(color.value, /^#[0-9A-F]{6}$/, color.id);
});

test("the first color is the Deyin mark's own tint, and the default pool is part of the set", () => {
  assert.equal(BOT_AVATAR_COLORS[0].value, "#8FB4FF");
  for (const shape of BOT_DEFAULT_SHAPE_POOL) assert.ok(isBotAvatarShape(shape));
  assert.ok(BOT_DEFAULT_SHAPE_POOL.length < BOT_AVATAR_SHAPES.length, "the sharper forms are left for choosing");
  assert.ok(!BOT_DEFAULT_SHAPE_POOL.includes("diamond") && !BOT_DEFAULT_SHAPE_POOL.includes("lozenge"));
});

test("type guards accept palette members only, and not the old names", () => {
  assert.equal(isBotAvatarShape("hexagon"), true);
  assert.equal(isBotAvatarShape("hex"), false, "the old name is migrated on read, not accepted on write");
  assert.equal(isBotAvatarShape("pumpkin"), false);
  assert.equal(isBotAvatarShape(3), false);
  assert.equal(isBotAvatarColor("iris"), true);
  assert.equal(isBotAvatarColor("violet"), false);
  assert.equal(isBotAvatarColor("purple"), false);
  assert.equal(isBotAvatarColor(undefined), false);
});

test("a color id resolves to its CSS value, unknown ids to the first color", () => {
  assert.equal(botAvatarColorValue("indigo"), "#4F7CFF");
  assert.equal(botAvatarColorValue("nope"), "#8FB4FF");
  assert.equal(botAvatarColorValue(""), "#8FB4FF");
});

test("luminance and contrast follow the WCAG definitions", () => {
  assert.equal(relativeLuminance("#000000"), 0);
  assert.equal(relativeLuminance("#ffffff"), 1);
  assert.ok(Math.abs(relativeLuminance("#808080") - 0.2158) < 0.001);
  assert.ok(Math.abs(relativeLuminance("#ff0000") - 0.2126) < 1e-6);
  assert.ok(Math.abs(relativeLuminance("#00ff00") - 0.7152) < 1e-6);
  assert.ok(Math.abs(relativeLuminance("#0000ff") - 0.0722) < 1e-6);
  assert.ok(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 1e-9);
  assert.equal(contrastRatio("#123456", "#123456"), 1);
  assert.equal(contrastRatio("#000000", "#ffffff"), contrastRatio("#ffffff", "#000000"), "order does not matter");
});

test("the mark is drawn in whichever of ink and white reads better, and always readable", () => {
  for (const color of BOT_AVATAR_COLORS) {
    const mark = botAvatarMarkValue(color.id);
    assert.ok(mark === BOT_AVATAR_INK || mark === BOT_AVATAR_WHITE, color.id);
    assert.ok(contrastRatio(color.value, mark) >= 4.5, `${color.id}: ${mark} on ${color.value}`);
    const other = mark === BOT_AVATAR_INK ? BOT_AVATAR_WHITE : BOT_AVATAR_INK;
    assert.ok(contrastRatio(color.value, mark) >= contrastRatio(color.value, other), `${color.id} picks the better one`);
  }
  assert.equal(botAvatarMarkValue("periwinkle"), BOT_AVATAR_INK);
  assert.equal(botAvatarMarkValue("ink"), BOT_AVATAR_WHITE);
  assert.equal(botAvatarMarkValue("nope"), botAvatarMarkValue("periwinkle"), "an unknown color reads as the first");
});

test("a default avatar is stable for an id and always valid", () => {
  const a = defaultBotAvatar("bot_abc123");
  assert.deepEqual(defaultBotAvatar("bot_abc123"), a);
  assert.ok(isBotAvatarShape(a.shape) && BOT_DEFAULT_SHAPE_POOL.includes(a.shape));
  assert.ok(isBotAvatarColor(a.color));
});

test("default avatars never pick ink and spread across the pool and the colors", () => {
  const shapes = new Set<string>();
  const colors = new Set<string>();
  for (let i = 0; i < 600; i++) {
    const avatar = defaultBotAvatar(`bot_${i}`);
    assert.notEqual(avatar.color, "ink");
    shapes.add(avatar.shape);
    colors.add(avatar.color);
  }
  assert.equal(shapes.size, BOT_DEFAULT_SHAPE_POOL.length, "every pooled shape turns up");
  assert.equal(colors.size, BOT_AVATAR_COLORS.length - 1, "every color but ink turns up");
});

test("resolveBotAvatar keeps current choices and repairs the rest from the id", () => {
  const fallback = defaultBotAvatar("bot_x");
  assert.deepEqual(resolveBotAvatar({ id: "bot_x", avatarShape: "octagon", avatarColor: "rose" }), { shape: "octagon", color: "rose" });
  assert.deepEqual(resolveBotAvatar({ id: "bot_x", avatarShape: "octagon", avatarColor: "chartreuse" }), { shape: "octagon", color: fallback.color });
  assert.deepEqual(resolveBotAvatar({ id: "bot_x", avatarShape: 5, avatarColor: "rose" }), { shape: fallback.shape, color: "rose" });
  assert.deepEqual(resolveBotAvatar({ id: "bot_x", avatarShape: "constructor", avatarColor: "__proto__" }), fallback, "inherited names are not choices");
  assert.deepEqual(resolveBotAvatar({ id: "bot_x" }), fallback);
});

test("every look a Bot could have been saved with before the redesign becomes a current one", () => {
  const oldShapes = ["blob", "pebble", "bean", "egg", "squircle", "tablet", "capsule", "cylinder", "hex", "gem", "crystal", "wedge", "shield", "dome", "arch", "cloud", "teardrop", "leaf", "square", "sparkle", "clover", "flower", "heart", "house", "star"];
  const oldColors = ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"];
  for (const shape of oldShapes) assert.ok(isBotAvatarShape(resolveBotAvatar({ id: "bot_legacy", avatarShape: shape, avatarColor: "rose" }).shape), shape);
  for (const color of oldColors) assert.ok(isBotAvatarColor(resolveBotAvatar({ id: "bot_legacy", avatarShape: "orb", avatarColor: color }).color), color);
});

test("an old look maps to its closest new one, so an owner's choice is recognisable", () => {
  const look = (avatarShape: string, avatarColor: string) => resolveBotAvatar({ id: "bot_legacy", avatarShape, avatarColor });
  assert.deepEqual(look("hex", "violet"), { shape: "hexagon", color: "iris" });
  assert.deepEqual(look("blob", "blue"), { shape: "orb", color: "indigo" });
  assert.deepEqual(look("star", "red"), { shape: "octagon", color: "rose" });
  assert.deepEqual(look("capsule", "green"), { shape: "pill", color: "mint" });
  assert.deepEqual(look("gem", "black"), { shape: "diamond", color: "ink" });
  assert.deepEqual(look("clover", "magenta"), { shape: "bloom", color: "orchid" });
  assert.deepEqual(look("square", "gray"), { shape: "tile", color: "slate" });
  assert.equal(look("orb", "yellow").color, "amber");
  assert.equal(look("orb", "orange").color, "coral");
  assert.equal(look("orb", "cyan").color, "teal");
  assert.equal(look("orb", "brown").color, "coral");
});

test("the avatar states are the lifecycle the chat maps onto", () => {
  assert.deepEqual([...BOT_AVATAR_STATES], ["idle", "thinking", "working", "waiting", "blocked", "finished", "failed", "sleeping"]);
});
