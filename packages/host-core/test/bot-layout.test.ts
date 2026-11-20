import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_BOT_LAYOUT,
  addBotSection,
  buildBotRoster,
  moveBotToSection,
  normalizeBotLayout,
  removeBotSection,
  renameBotSection,
  setBotHidden,
  setBotPinned,
} from "../src/bots/layout.js";
import { BOT_LIMITS, BotError, normalizeBot, type DeyinBot } from "../src/bots/types.js";

function bot(id: string, patch: Partial<DeyinBot> = {}): DeyinBot {
  return normalizeBot({ id, name: id, createdAt: Number(id.replace(/\D/g, "")) || 0, ...patch })!;
}

const ids = (bots: DeyinBot[]): string[] => bots.map((b) => b.id);

test("pinning appends in pin order, and unpinning removes", () => {
  let layout = setBotPinned(EMPTY_BOT_LAYOUT, "b2", true);
  layout = setBotPinned(layout, "b1", true);
  assert.deepEqual(layout.pinned, ["b2", "b1"]);
  layout = setBotPinned(layout, "b2", true);
  assert.deepEqual(layout.pinned, ["b1", "b2"], "re-pinning moves it to the end rather than duplicating");
  assert.deepEqual(setBotPinned(layout, "b1", false).pinned, ["b2"]);
});

test("hiding a Bot unpins it and pinning a hidden Bot reveals it", () => {
  const pinned = setBotPinned(EMPTY_BOT_LAYOUT, "b1", true);
  const hidden = setBotHidden(pinned, "b1", true);
  assert.deepEqual(hidden.hidden, ["b1"]);
  assert.deepEqual(hidden.pinned, []);
  const back = setBotPinned(hidden, "b1", true);
  assert.deepEqual(back.hidden, []);
  assert.deepEqual(back.pinned, ["b1"]);
  assert.deepEqual(setBotHidden(hidden, "b1", false).hidden, []);
});

test("layout operations do not mutate the layout they are given", () => {
  const base = Object.freeze({ pinned: Object.freeze(["a"]), hidden: Object.freeze([]), sections: Object.freeze([]) }) as never;
  assert.doesNotThrow(() => setBotPinned(base, "b", true));
  assert.doesNotThrow(() => setBotHidden(base, "b", true));
  assert.doesNotThrow(() => addBotSection(base, "s", "S"));
});

test("sections: add, rename and remove", () => {
  let layout = addBotSection(EMPTY_BOT_LAYOUT, "s1", "  Work  ");
  assert.deepEqual(layout.sections, [{ id: "s1", name: "Work", botIds: [] }]);
  layout = renameBotSection(layout, "s1", "Deep work");
  assert.equal(layout.sections[0]!.name, "Deep work");
  layout = removeBotSection(layout, "s1");
  assert.deepEqual(layout.sections, []);
});

test("section names must be present, short enough and unique ignoring case", () => {
  const layout = addBotSection(EMPTY_BOT_LAYOUT, "s1", "Work");
  assert.throws(() => addBotSection(layout, "s2", "  "), (e: unknown) => e instanceof BotError && e.code === "invalid");
  assert.throws(() => addBotSection(layout, "s2", "x".repeat(BOT_LIMITS.sectionName + 1)), (e: unknown) => e instanceof BotError && e.code === "invalid");
  assert.throws(() => addBotSection(layout, "s2", "WORK"), (e: unknown) => e instanceof BotError && e.code === "conflict");
  const two = addBotSection(layout, "s2", "Home");
  assert.throws(() => renameBotSection(two, "s2", "work"), (e: unknown) => e instanceof BotError && e.code === "conflict");
  assert.doesNotThrow(() => renameBotSection(two, "s2", "HOME"), "renaming to its own name differing in case is allowed");
});

test("there is a cap on sections", () => {
  let layout = EMPTY_BOT_LAYOUT;
  for (let i = 0; i < BOT_LIMITS.maxSections; i++) layout = addBotSection(layout, `s${i}`, `Section ${i}`);
  assert.throws(() => addBotSection(layout, "extra", "One too many"), (e: unknown) => e instanceof BotError && e.code === "limit");
});

test("operations on a section that is gone say so", () => {
  for (const op of [
    () => renameBotSection(EMPTY_BOT_LAYOUT, "nope", "X"),
    () => removeBotSection(EMPTY_BOT_LAYOUT, "nope"),
    () => moveBotToSection(EMPTY_BOT_LAYOUT, "b1", "nope"),
  ]) {
    assert.throws(op, (e: unknown) => e instanceof BotError && e.code === "not_found");
  }
});

test("a Bot is in at most one section; moving it to null takes it out of all", () => {
  let layout = addBotSection(addBotSection(EMPTY_BOT_LAYOUT, "s1", "One"), "s2", "Two");
  layout = moveBotToSection(layout, "b1", "s1");
  layout = moveBotToSection(layout, "b1", "s2");
  assert.deepEqual(layout.sections.map((s) => s.botIds), [[], ["b1"]]);
  layout = moveBotToSection(layout, "b1", null);
  assert.deepEqual(layout.sections.map((s) => s.botIds), [[], []]);
});

test("removing a section sends its Bots back to the unsectioned list instead of losing them", () => {
  const layout = removeBotSection(moveBotToSection(addBotSection(EMPTY_BOT_LAYOUT, "s1", "One"), "b1", "s1"), "s1");
  const roster = buildBotRoster([bot("b1")], layout);
  assert.deepEqual(ids(roster.groups[0]!.bots), ["b1"]);
  assert.equal(roster.groups[0]!.section, null);
});

test("normalizeBotLayout repairs duplicates, contradictions and junk", () => {
  const valid = new Set(["a", "b", "c"]);
  const layout = normalizeBotLayout(
    {
      pinned: ["a", "a", "b", 7],
      hidden: ["b", "ghost"],
      sections: [
        { id: "s1", name: "One", botIds: ["a", "c"] },
        { id: "s1", name: "Dup id", botIds: ["b"] },
        { id: "s2", name: "  ", botIds: [] },
        { id: "s3", name: "Three", botIds: ["c", "b"] },
        null,
        "junk",
      ],
    },
    valid,
  );
  assert.deepEqual(layout.hidden, ["b"]);
  assert.deepEqual(layout.pinned, ["a"], "hidden Bots are not pinned");
  assert.deepEqual(layout.sections, [
    { id: "s1", name: "One", botIds: ["a", "c"] },
    { id: "s3", name: "Three", botIds: ["b"] },
  ]);
});

test("normalizeBotLayout survives non-objects and over-long section lists", () => {
  for (const raw of [undefined, null, 4, "x", []]) assert.deepEqual(normalizeBotLayout(raw, new Set()), EMPTY_BOT_LAYOUT);
  const many = Array.from({ length: BOT_LIMITS.maxSections + 5 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, botIds: [] }));
  assert.equal(normalizeBotLayout({ sections: many }, new Set()).sections.length, BOT_LIMITS.maxSections);
});

test("the roster leads with pinned Bots in pin order, then groups, with the primary first", () => {
  const bots = [bot("b1"), bot("b2", { isPrimary: true }), bot("b3"), bot("b4"), bot("b5")];
  let layout = setBotPinned(setBotPinned(EMPTY_BOT_LAYOUT, "b4", true), "b3", true);
  layout = moveBotToSection(addBotSection(layout, "s1", "Work"), "b5", "s1");
  const roster = buildBotRoster(bots, layout);
  assert.deepEqual(ids(roster.pinned), ["b4", "b3"]);
  assert.equal(roster.groups[0]!.section, null);
  assert.deepEqual(ids(roster.groups[0]!.bots), ["b2", "b1"], "primary first, then oldest first");
  assert.equal(roster.groups[1]!.section?.name, "Work");
  assert.deepEqual(ids(roster.groups[1]!.bots), ["b5"]);
});

test("a pinned Bot is shown once, in the pinned strip and not again in its section", () => {
  const layout = moveBotToSection(addBotSection(setBotPinned(EMPTY_BOT_LAYOUT, "b1", true), "s1", "Work"), "b1", "s1");
  const roster = buildBotRoster([bot("b1"), bot("b2")], layout);
  assert.deepEqual(ids(roster.pinned), ["b1"]);
  assert.equal(roster.groups.flatMap((g) => ids(g.bots)).includes("b1"), false);
});

test("an empty named section is still listed, an empty unsectioned group is not", () => {
  const roster = buildBotRoster([], addBotSection(EMPTY_BOT_LAYOUT, "s1", "Empty"));
  assert.equal(roster.groups.length, 1);
  assert.equal(roster.groups[0]!.section?.name, "Empty");
  assert.deepEqual(roster.groups[0]!.bots, []);
});

test("hidden and archived Bots are kept out of the main list but stay reachable", () => {
  const bots = [bot("b1"), bot("b2"), bot("b3", { archived: true })];
  const roster = buildBotRoster(bots, setBotHidden(EMPTY_BOT_LAYOUT, "b2", true));
  assert.deepEqual(ids(roster.groups.flatMap((g) => g.bots)), ["b1"]);
  assert.deepEqual(ids(roster.hidden), ["b2"]);
  assert.deepEqual(ids(roster.archived), ["b3"]);
});

test("an archived Bot is not pinned even if the layout still says so", () => {
  const roster = buildBotRoster([bot("b1", { archived: true })], setBotPinned(EMPTY_BOT_LAYOUT, "b1", true));
  assert.deepEqual(roster.pinned, []);
  assert.deepEqual(ids(roster.archived), ["b1"]);
});
