import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_BOTS_STATE, normalizeBotsState, settleBotsState } from "../src/bots/state.js";
import type { DeyinBot } from "../src/bots/types.js";

let clock = 0;
function agent(id: string, patch: Partial<DeyinBot> = {}): Record<string, unknown> {
  clock += 1;
  return { id, name: id, createdAt: clock, updatedAt: clock, ...patch };
}

const byId = (bots: DeyinBot[], id: string): DeyinBot => bots.find((bot) => bot.id === id)!;

test("nothing stored is an empty roster and not a repair, so first launch writes no file", () => {
  for (const raw of [undefined, null, {}, [], "junk", 5, { bots: "no" }, EMPTY_BOTS_STATE]) {
    const { state, changed } = normalizeBotsState(raw);
    assert.deepEqual(state.bots, []);
    assert.equal(changed, false, JSON.stringify(raw));
  }
});

test("a state the settle step produced is a fixed point: reading it back changes nothing", () => {
  const settled = settleBotsState({ bots: [agent("a"), agent("b"), agent("c", { archived: true })] });
  const roundTripped = JSON.parse(JSON.stringify(settled));
  const again = normalizeBotsState(roundTripped);
  assert.equal(again.changed, false);
  assert.deepEqual(again.state, settled);
});

test("a hand-edited state that needs repair is reported as changed", () => {
  const { changed, state } = normalizeBotsState({ bots: [{ id: "a", name: "A", isPrimary: false }, { id: "b" }, "junk"] });
  assert.equal(changed, true);
  assert.deepEqual(state.bots.map((b) => b.id), ["a"]);
});

test("damaged entries and duplicate ids are dropped, keeping the first of a duplicate", () => {
  const { bots } = settleBotsState({ bots: [agent("a", { name: "First" }), agent("a", { name: "Second" }), null, 3, { id: "../x", name: "bad" }] });
  assert.equal(bots.length, 1);
  assert.equal(bots[0]!.name, "First");
});

test("handles are unique, well-formed, and the earliest Bot keeps a contested one", () => {
  const { bots } = settleBotsState({
    bots: [agent("a", { name: "Ava" }), agent("b", { name: "Ava" }), agent("c", { name: "Cy", handle: "Not Valid!" }), agent("d", { name: "Dee", handle: "ava" })],
  });
  assert.equal(byId(bots, "a").handle, "ava");
  assert.equal(byId(bots, "b").handle, "ava-2");
  assert.equal(byId(bots, "c").handle, "cy");
  assert.equal(byId(bots, "d").handle, "dee");
  assert.equal(new Set(bots.map((b) => b.handle)).size, bots.length);
});

test("with no primary claimed, the oldest active agent is promoted", () => {
  const { bots } = settleBotsState({ bots: [agent("young", { createdAt: 50 }), agent("old", { createdAt: 5 })] });
  assert.equal(byId(bots, "old").isPrimary, true);
  assert.equal(byId(bots, "young").isPrimary, false);
});

test("when several claim to be primary the oldest claimant keeps it", () => {
  const { bots } = settleBotsState({
    bots: [agent("a", { createdAt: 9, isPrimary: true }), agent("b", { createdAt: 3, isPrimary: true }), agent("c", { createdAt: 1 })],
  });
  assert.deepEqual(bots.filter((b) => b.isPrimary).map((b) => b.id), ["b"]);
});

test("an archived Bot cannot stay primary; the next oldest active agent takes over", () => {
  const { bots } = settleBotsState({
    bots: [agent("a", { createdAt: 1, isPrimary: true, archived: true }), agent("b", { createdAt: 2 }), agent("c", { createdAt: 3 })],
  });
  assert.equal(byId(bots, "a").isPrimary, false);
  assert.equal(byId(bots, "b").isPrimary, true);
});

test("a room is never primary and does not count as an agent", () => {
  const { bots } = settleBotsState({
    bots: [agent("r", { kind: "room", memberBotIds: ["a", "b"], isPrimary: true, createdAt: 1 }), agent("a", { createdAt: 2 }), agent("b", { createdAt: 3 })],
  });
  assert.equal(byId(bots, "r").isPrimary, false);
  assert.equal(byId(bots, "a").isPrimary, true);
});

test("no active agent means no primary", () => {
  const { bots } = settleBotsState({ bots: [agent("a", { archived: true, isPrimary: true })] });
  assert.equal(bots.some((b) => b.isPrimary), false);
  assert.equal(settleBotsState({ bots: [] }).bots.length, 0);
});

test("a room drops members that no longer exist or are not agents", () => {
  const { bots } = settleBotsState({
    bots: [
      agent("a"),
      agent("b"),
      agent("c"),
      agent("other-room", { kind: "room", memberBotIds: ["a", "b"] }),
      agent("r", { kind: "room", memberBotIds: ["a", "ghost", "other-room", "b", "c"] }),
    ],
  });
  assert.deepEqual(byId(bots, "r").memberBotIds, ["a", "b", "c"]);
  assert.equal(byId(bots, "r").archived, false);
});

test("an active room loses archived members, and is archived when fewer than two remain", () => {
  const { bots } = settleBotsState({
    bots: [agent("a"), agent("b", { archived: true }), agent("c", { archived: true }), agent("r", { kind: "room", memberBotIds: ["a", "b", "c"] })],
  });
  assert.deepEqual(byId(bots, "r").memberBotIds, ["a"]);
  assert.equal(byId(bots, "r").archived, true, "archived rather than deleted, so it can be recovered");
});

test("an archived room keeps its archived members so restoring is possible", () => {
  const { bots } = settleBotsState({
    bots: [agent("a"), agent("b", { archived: true }), agent("r", { kind: "room", archived: true, memberBotIds: ["a", "b", "ghost"] })],
  });
  assert.deepEqual(byId(bots, "r").memberBotIds, ["a", "b"]);
});

test("the layout only mentions Bots that exist", () => {
  const { layout } = settleBotsState({
    bots: [agent("a"), agent("b")],
    layout: { pinned: ["a", "ghost"], hidden: ["b", "ghost"], sections: [{ id: "s1", name: "Work", botIds: ["a", "ghost"] }] },
  });
  assert.deepEqual(layout.pinned, ["a"]);
  assert.deepEqual(layout.hidden, ["b"]);
  assert.deepEqual(layout.sections[0]!.botIds, ["a"]);
});

test("settling never mutates its input", () => {
  const input = Object.freeze({
    bots: Object.freeze([Object.freeze(agent("a")), Object.freeze(agent("b", { isPrimary: true }))]),
    layout: Object.freeze({ pinned: Object.freeze(["a"]), hidden: [], sections: [] }),
  });
  assert.doesNotThrow(() => settleBotsState(input));
});
