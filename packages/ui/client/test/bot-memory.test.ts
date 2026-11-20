import assert from "node:assert/strict";
import test from "node:test";
import type { BotMemoryFactView } from "@deyin/host-core/shared";
import { orderMemory } from "../src/bots/botMemory.js";

function fact(name: string, over: Partial<BotMemoryFactView> = {}): BotMemoryFactView {
  return { id: name, name, title: name, description: "", type: "user", shared: false, revision: 1, updatedAt: "2026-01-01T00:00:00.000Z", body: "", ...over };
}

test("private facts come before shared ones", () => {
  const order = orderMemory([fact("s", { shared: true }), fact("p")]).map((f) => f.name);
  assert.deepEqual(order, ["p", "s"]);
});

test("within a group the newest fact is first", () => {
  const order = orderMemory([fact("old", { updatedAt: "2026-01-01T00:00:00.000Z" }), fact("new", { updatedAt: "2026-03-01T00:00:00.000Z" })]).map((f) => f.name);
  assert.deepEqual(order, ["new", "old"]);
});

test("equal times fall back to name so the order is stable", () => {
  const order = orderMemory([fact("b"), fact("a")]).map((f) => f.name);
  assert.deepEqual(order, ["a", "b"]);
});

test("the input list is not reordered in place", () => {
  const input = [fact("s", { shared: true }), fact("p")];
  orderMemory(input);
  assert.deepEqual(input.map((f) => f.name), ["s", "p"]);
});

test("no facts is no facts", () => {
  assert.deepEqual(orderMemory([]), []);
});
