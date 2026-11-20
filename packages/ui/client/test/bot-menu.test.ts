import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_BOT_LAYOUT, defaultBotAvatar, type BotRosterLayout, type DeyinBot } from "@deyin/host-core/shared";
import { addedSectionId, botMenuActions, sectionOfBot, type BotMenuAction } from "../src/bots/botMenu.js";

function bot(over: Partial<DeyinBot> = {}): DeyinBot {
  const avatar = defaultBotAvatar("bot_1");
  return {
    id: "bot_1",
    name: "Ada",
    handle: "ada",
    description: "",
    title: "",
    avatarShape: avatar.shape,
    avatarColor: avatar.color,
    avatarVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    harness: "local",
    role: "assistant",
    visibility: "owner",
    kind: "agent",
    memberBotIds: [],
    autoReview: { approvalMode: "auto_review" },
    isPrimary: false,
    archived: false,
    ...over,
  };
}

const kinds = (actions: BotMenuAction[]): string[] => actions.map((a) => a.kind);

const sections: BotRosterLayout = {
  pinned: [],
  hidden: [],
  sections: [
    { id: "s1", name: "Work", botIds: ["bot_1"] },
    { id: "s2", name: "Home", botIds: [] },
  ],
};

test("a plain active Bot can be opened, pinned, hidden, filed, made primary, archived and deleted", () => {
  assert.deepEqual(kinds(botMenuActions(bot(), EMPTY_BOT_LAYOUT)), [
    "details",
    "pin",
    "hide",
    "newSection",
    "makePrimary",
    "archive",
    "delete",
  ]);
});

test("a pinned Bot offers Unpin, and a hidden one offers Show", () => {
  assert.ok(kinds(botMenuActions(bot(), { ...EMPTY_BOT_LAYOUT, pinned: ["bot_1"] })).includes("unpin"));
  assert.ok(!kinds(botMenuActions(bot(), { ...EMPTY_BOT_LAYOUT, pinned: ["bot_1"] })).includes("pin"));
  assert.ok(kinds(botMenuActions(bot(), { ...EMPTY_BOT_LAYOUT, hidden: ["bot_1"] })).includes("show"));
  assert.ok(!kinds(botMenuActions(bot(), { ...EMPTY_BOT_LAYOUT, hidden: ["bot_1"] })).includes("hide"));
});

test("every section is offered, the current one is marked, and 'No section' appears only when filed", () => {
  const actions = botMenuActions(bot(), sections);
  const offered = actions.filter((a): a is Extract<BotMenuAction, { kind: "section" }> => a.kind === "section");
  assert.deepEqual(offered.map((a) => [a.sectionId, a.name, a.current]), [["s1", "Work", true], ["s2", "Home", false]]);
  assert.ok(kinds(actions).includes("noSection"));
  assert.ok(!kinds(botMenuActions(bot({ id: "bot_2" }), sections)).includes("noSection"), "bot_2 is not filed");
});

test("the primary Bot is not offered 'Make primary'", () => {
  assert.ok(!kinds(botMenuActions(bot({ isPrimary: true }), EMPTY_BOT_LAYOUT)).includes("makePrimary"));
});

test("a room cannot be made primary, because only agents coordinate", () => {
  const room = bot({ kind: "room", memberBotIds: ["a", "b"] });
  assert.ok(!kinds(botMenuActions(room, EMPTY_BOT_LAYOUT)).includes("makePrimary"));
  assert.ok(kinds(botMenuActions(room, EMPTY_BOT_LAYOUT)).includes("archive"), "but it can still be archived");
});

test("an archived Bot can only be opened, restored or deleted", () => {
  const archived = bot({ archived: true });
  assert.deepEqual(kinds(botMenuActions(archived, EMPTY_BOT_LAYOUT)), ["details", "restore", "delete"]);
  assert.deepEqual(
    kinds(botMenuActions(archived, { pinned: ["bot_1"], hidden: [], sections: sections.sections })),
    ["details", "restore", "delete"],
    "pins and sections do not unlock more actions",
  );
});

test("delete is always the last entry so it is never next to a frequent one by accident", () => {
  for (const layout of [EMPTY_BOT_LAYOUT, sections, { ...EMPTY_BOT_LAYOUT, pinned: ["bot_1"] }]) {
    for (const b of [bot(), bot({ isPrimary: true }), bot({ archived: true })]) {
      assert.equal(botMenuActions(b, layout).at(-1)?.kind, "delete");
    }
  }
});

test("no menu offers the same action twice", () => {
  for (const b of [bot(), bot({ isPrimary: true }), bot({ archived: true })]) {
    const list = botMenuActions(b, sections).map((a) => (a.kind === "section" ? `section:${a.sectionId}` : a.kind));
    assert.equal(new Set(list).size, list.length);
  }
});

test("sectionOfBot finds the section a Bot is filed under", () => {
  assert.equal(sectionOfBot(sections, "bot_1"), "s1");
  assert.equal(sectionOfBot(sections, "nobody"), null);
  assert.equal(sectionOfBot(EMPTY_BOT_LAYOUT, "bot_1"), null);
});

test("the section a host just created is found by id, even when another has the same name", () => {
  const before: BotRosterLayout = { pinned: [], hidden: [], sections: [{ id: "s1", name: "Work", botIds: [] }] };
  const after: BotRosterLayout = { ...before, sections: [...before.sections, { id: "s2", name: "Work", botIds: [] }] };
  assert.equal(addedSectionId(before, after), "s2");
});

test("no new section means no id, so a failed add never moves a Bot into the wrong one", () => {
  assert.equal(addedSectionId(sections, sections), null);
  assert.equal(addedSectionId(sections, EMPTY_BOT_LAYOUT), null);
});

test("the first section ever created is found against an empty layout", () => {
  assert.equal(addedSectionId(EMPTY_BOT_LAYOUT, { ...EMPTY_BOT_LAYOUT, sections: [{ id: "s9", name: "New", botIds: [] }] }), "s9");
});
