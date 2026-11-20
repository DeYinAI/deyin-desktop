import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_LIMITS,
  BotError,
  botResult,
  checkBotFields,
  checkBotName,
  cleanBotLine,
  cleanBotText,
  isSafeBotId,
  normalizeBot,
  slugifyBotHandle,
  uniqueBotHandle,
} from "../src/bots/types.js";
import { defaultBotAvatar } from "../src/bots/avatar.js";

test("isSafeBotId accepts ordinary ids and refuses anything that could leave the Bots directory", () => {
  for (const ok of ["bot_abc123", "a", "Bot-1", "x".repeat(64)]) assert.equal(isSafeBotId(ok), true, ok);
  for (const bad of ["", "../x", "a/b", "a\\b", "_shared", ".hidden", "-lead", "x".repeat(65), "has space", 7, null, undefined]) {
    assert.equal(isSafeBotId(bad), false, String(bad));
  }
});

test("cleanBotLine collapses whitespace and drops control characters", () => {
  assert.equal(cleanBotLine("  Research \n\t Bot\u0007 "), "Research Bot");
  assert.equal(cleanBotLine(42), "");
  assert.equal(cleanBotLine(undefined), "");
});

test("cleanBotText keeps line breaks and tabs but drops other control characters", () => {
  assert.equal(cleanBotText("  one\r\ntwo\u0000\tthree  "), "one\ntwo\tthree");
  assert.equal(cleanBotText(null), "");
});

test("slugifyBotHandle produces lowercase ascii words", () => {
  assert.equal(slugifyBotHandle("Research Bot"), "research-bot");
  assert.equal(slugifyBotHandle("  Café   Ünï!! "), "cafe-uni");
  assert.equal(slugifyBotHandle("a_b.c"), "a-b-c");
});

test("slugifyBotHandle falls back to 'bot' when nothing ascii survives", () => {
  for (const name of ["研究助手", "🚀🚀", "!!!", ""]) assert.equal(slugifyBotHandle(name), "bot", JSON.stringify(name));
});

test("slugifyBotHandle never exceeds the limit or ends with a hyphen", () => {
  const handle = slugifyBotHandle("word ".repeat(30));
  assert.ok(handle.length <= BOT_LIMITS.handle);
  assert.doesNotMatch(handle, /-$/);
});

test("uniqueBotHandle suffixes until free and stays within the limit", () => {
  assert.equal(uniqueBotHandle("Ava", new Set()), "ava");
  assert.equal(uniqueBotHandle("Ava", new Set(["ava"])), "ava-2");
  assert.equal(uniqueBotHandle("Ava", new Set(["ava", "ava-2", "ava-3"])), "ava-4");
  const long = slugifyBotHandle("x".repeat(60));
  const next = uniqueBotHandle("x".repeat(60), new Set([long]));
  assert.ok(next.length <= BOT_LIMITS.handle, next);
  assert.notEqual(next, long);
});

test("checkBotName requires a name of a sensible length", () => {
  assert.equal(checkBotName("Ava"), null);
  assert.match(checkBotName("")!, /needs a name/);
  assert.match(checkBotName("   \n ")!, /needs a name/);
  assert.match(checkBotName(undefined)!, /needs a name/);
  assert.match(checkBotName("x".repeat(BOT_LIMITS.name + 1))!, /at most/);
  assert.equal(checkBotName("x".repeat(BOT_LIMITS.name)), null);
});

test("checkBotFields: create needs a name, update does not", () => {
  assert.match(checkBotFields({}, "create")!, /needs a name/);
  assert.equal(checkBotFields({}, "update"), null);
  assert.match(checkBotFields({ name: " " }, "update")!, /needs a name/, "but a name that is sent must be valid");
});

test("checkBotFields rejects over-long free text", () => {
  assert.match(checkBotFields({ name: "a", description: "x".repeat(BOT_LIMITS.description + 1) }, "create")!, /description/);
  assert.match(checkBotFields({ name: "a", purpose: "x".repeat(BOT_LIMITS.purpose + 1) }, "create")!, /purpose/);
  assert.match(checkBotFields({ name: "a", title: "x".repeat(BOT_LIMITS.title + 1) }, "create")!, /title/);
  assert.match(checkBotFields({ name: "a", role: "x".repeat(BOT_LIMITS.role + 1) }, "create")!, /role/);
  assert.match(checkBotFields({ name: "a", publicDescription: "x".repeat(BOT_LIMITS.publicDescription + 1) }, "create")!, /public description/);
  assert.match(checkBotFields({ name: "a", description: 5 as unknown as string }, "create")!, /must be text/);
});

test("checkBotFields rejects avatars outside the palette", () => {
  assert.match(checkBotFields({ name: "a", avatarShape: "pumpkin" as never }, "create")!, /shape/);
  assert.match(checkBotFields({ name: "a", avatarColor: "chartreuse" as never }, "create")!, /color/);
  assert.equal(checkBotFields({ name: "a", avatarShape: "hexagon", avatarColor: "iris" }, "create"), null);
});

test("checkBotFields only accepts raster data URLs for uploaded avatars", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(checkBotFields({ avatarUrl: png }, "update"), null);
  assert.equal(checkBotFields({ avatarUrl: null }, "update"), null, "null clears the avatar");
  assert.match(checkBotFields({ avatarUrl: "https://evil.example/a.png" }, "update")!, /PNG, JPEG or WebP/);
  assert.match(checkBotFields({ avatarUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }, "update")!, /PNG, JPEG or WebP/, "svg can carry script");
  assert.match(checkBotFields({ avatarUrl: "javascript:alert(1)" }, "update")!, /PNG, JPEG or WebP/);
  assert.match(checkBotFields({ avatarUrl: `data:image/png;base64,${"A".repeat(BOT_LIMITS.avatarUrl)}` }, "update")!, /too large/);
});

test("checkBotFields: a server Bot needs a server, and unknown choices are refused", () => {
  assert.match(checkBotFields({ name: "a", harness: "server" }, "create")!, /needs the server/);
  assert.match(checkBotFields({ name: "a", harness: "server", hostId: "  " }, "create")!, /needs the server/);
  assert.equal(checkBotFields({ name: "a", harness: "server", hostId: "dell" }, "create"), null);
  assert.match(checkBotFields({ name: "a", harness: "cloud" as never }, "create")!, /place to run/);
  assert.match(checkBotFields({ name: "a", approvalMode: "yolo" as never }, "create")!, /approval mode/);
  assert.match(checkBotFields({ name: "a", kind: "swarm" as never }, "create")!, /kind of Bot/);
});

test("checkBotFields refuses team visibility, which needs a team workspace Deyin does not have", () => {
  assert.match(checkBotFields({ name: "a", visibility: "team" }, "create")!, /team workspace/);
  assert.equal(checkBotFields({ name: "a", visibility: "owner" }, "create"), null);
  assert.match(checkBotFields({ name: "a", visibility: "public" as never }, "create")!, /Unknown visibility/);
});

test("checkBotFields requires room members to be safe Bot ids", () => {
  assert.equal(checkBotFields({ name: "r", kind: "room", memberBotIds: ["bot_1", "bot_2"] }, "create"), null);
  assert.match(checkBotFields({ name: "r", kind: "room", memberBotIds: ["../etc"] }, "create")!, /Bot ids/);
  assert.match(checkBotFields({ name: "r", memberBotIds: "bot_1" as never }, "create")!, /Bot ids/);
});

test("normalizeBot discards what has no usable id or name", () => {
  for (const raw of [null, undefined, 3, "x", [], {}, { id: "bot_1" }, { id: "bot_1", name: "   " }, { id: "../x", name: "A" }, { name: "A" }]) {
    assert.equal(normalizeBot(raw), null, JSON.stringify(raw));
  }
});

test("normalizeBot fills every field of a minimal record with sane defaults", () => {
  const bot = normalizeBot({ id: "bot_1", name: "Ava" })!;
  const avatar = defaultBotAvatar("bot_1");
  assert.deepEqual(bot, {
    id: "bot_1",
    name: "Ava",
    handle: "ava",
    description: "",
    title: "",
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    avatarVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    harness: "local",
    role: "assistant",
    visibility: "owner",
    kind: "agent",
    memberBotIds: [],
    autoReview: { approvalMode: "auto_review" },
    isPrimary: false,
    archived: false,
  });
});

test("normalizeBot repairs fields that make no sense together", () => {
  const bot = normalizeBot({
    id: "bot_1",
    name: "Ava",
    harness: "local",
    hostId: "dell",
    memberBotIds: ["bot_2"],
    visibility: "team",
    isPrimary: true,
    autoReview: { approvalMode: "chaos" },
    avatarShape: "pumpkin",
    avatarColor: "chartreuse",
    avatarUrl: "javascript:1",
    avatarVersion: "two",
    createdAt: "yesterday",
  })!;
  assert.equal(bot.hostId, undefined, "a local Bot has no host");
  assert.deepEqual(bot.memberBotIds, [], "an agent has no members");
  assert.equal(bot.visibility, "owner");
  assert.equal(bot.autoReview.approvalMode, "auto_review");
  assert.equal(bot.avatarUrl, undefined);
  assert.equal(bot.avatarVersion, 1);
  assert.equal(bot.createdAt, 0);
  const avatar = defaultBotAvatar("bot_1");
  assert.equal(bot.avatarShape, avatar.shape);
  assert.equal(bot.avatarColor, avatar.color);
});

test("normalizeBot keeps a server Bot's host and a room's members, and never lets a room be primary", () => {
  const server = normalizeBot({ id: "bot_1", name: "Ava", harness: "server", hostId: " dell " })!;
  assert.equal(server.harness, "server");
  assert.equal(server.hostId, "dell");
  const room = normalizeBot({ id: "bot_r", name: "War room", kind: "room", memberBotIds: ["bot_1", "bot_2", "bot_1", "../x"], isPrimary: true })!;
  assert.deepEqual(room.memberBotIds, ["bot_1", "bot_2"]);
  assert.equal(room.isPrimary, false);
});

test("normalizeBot keeps optional text only when it has content and clamps its length", () => {
  const bot = normalizeBot({ id: "bot_1", name: "x".repeat(200), purpose: "  ", publicDescription: "ok", description: "d".repeat(2000) })!;
  assert.equal(bot.name.length, BOT_LIMITS.name);
  assert.equal(bot.purpose, undefined);
  assert.equal(bot.publicDescription, "ok");
  assert.equal(bot.description.length, BOT_LIMITS.description);
});

test("normalizeBot does not mutate its input", () => {
  const raw = Object.freeze({ id: "bot_1", name: " Ava ", memberBotIds: Object.freeze(["bot_2"]) });
  assert.doesNotThrow(() => normalizeBot(raw));
});

test("botResult wraps a value and turns a BotError into a readable failure", () => {
  assert.deepEqual(botResult(() => 42), { ok: true, value: 42 });
  assert.deepEqual(
    botResult(() => {
      throw new BotError("conflict", "Already there.");
    }),
    { ok: false, error: "Already there.", code: "conflict" },
  );
});

test("botResult does not swallow bugs: a non-BotError still throws", () => {
  assert.throws(
    () =>
      botResult(() => {
        throw new TypeError("boom");
      }),
    /boom/,
  );
});
