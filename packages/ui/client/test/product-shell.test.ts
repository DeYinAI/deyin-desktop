import assert from "node:assert/strict";
import test from "node:test";
import { BOTS_PROJECT_ID, type DeyinBot, type Project, type Thread } from "@deyin/host-core/shared";
import { botOfThread, routeMode, threadToOpenForBot } from "../src/productShell.js";

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return { id, title: id, mode: "agent", createdAt: 1, updatedAt: 1, events: [], ...over } as Thread;
}

function project(id: string, threads: Thread[]): Project {
  return { id, name: id, root: null, threads } as Project;
}

test("choosing Conductor from Code moves into the Conductor product", () => {
  assert.deepEqual(routeMode("conductor", "code", true), { kind: "switch-product", product: "conductor", mode: "conductor" });
});

test("choosing Conductor from a Bot also moves into Conductor", () => {
  assert.deepEqual(routeMode("conductor", "bot", true), { kind: "switch-product", product: "conductor", mode: "conductor" });
});

test("choosing Conductor while already in it changes nothing about the product", () => {
  assert.deepEqual(routeMode("conductor", "conductor", true), { kind: "set-mode", mode: "conductor" });
});

test("a host with no runtime refuses Conductor from every product", () => {
  for (const product of ["code", "bot", "conductor"] as const) assert.deepEqual(routeMode("conductor", product, false), { kind: "ignore" }, product);
});

test("leaving Conductor for another mode returns to Code with that mode", () => {
  assert.deepEqual(routeMode("agent", "conductor", true), { kind: "switch-product", product: "code", mode: "agent" });
  assert.deepEqual(routeMode("plan", "conductor", true), { kind: "switch-product", product: "code", mode: "plan" });
});

test("Code sets any of its own modes", () => {
  for (const mode of ["agent", "plan", "ask", "delivery"] as const) assert.deepEqual(routeMode(mode, "code", true), { kind: "set-mode", mode });
});

test("a Bot accepts only agent mode and ignores Code-only modes", () => {
  assert.deepEqual(routeMode("agent", "bot", true), { kind: "set-mode", mode: "agent" });
  for (const mode of ["plan", "ask", "delivery"] as const) assert.deepEqual(routeMode(mode, "bot", true), { kind: "ignore" }, mode);
});

test("a Bot opens on its newest live conversation", () => {
  const projects = [
    project("code", [thread("c1")]),
    project(BOTS_PROJECT_ID, [thread("old", { botId: "ada", updatedAt: 5 }), thread("new", { botId: "ada", updatedAt: 9 }), thread("other", { botId: "bo", updatedAt: 99 })]),
  ];
  assert.equal(threadToOpenForBot(projects, "ada")?.id, "new");
});

test("a Bot's archived conversations are never opened", () => {
  const projects = [project(BOTS_PROJECT_ID, [thread("gone", { botId: "ada", updatedAt: 9, archived: true }), thread("kept", { botId: "ada", updatedAt: 1 })])];
  assert.equal(threadToOpenForBot(projects, "ada")?.id, "kept");
});

test("a Bot with no conversation opens on none, so one can be started", () => {
  assert.equal(threadToOpenForBot([project("code", [thread("c1")])], "ada"), null);
  assert.equal(threadToOpenForBot([], "ada"), null);
});

test("a Code conversation that carries a stray botId in a workspace is not a Bot's", () => {
  const projects = [project("code", [thread("c1", { botId: "ada" })])];
  assert.equal(threadToOpenForBot(projects, "ada"), null);
});

const bots = [{ id: "ada" }, { id: "bo" }] as DeyinBot[];

test("the open conversation's Bot is the one it names", () => {
  assert.equal(botOfThread(thread("t", { botId: "bo" }), bots)?.id, "bo");
});

test("a conversation with no Bot, or no conversation, has no Bot", () => {
  assert.equal(botOfThread(thread("t"), bots), null);
  assert.equal(botOfThread(null, bots), null);
});

test("a conversation of a Bot that no longer exists has no Bot, and does not borrow another", () => {
  assert.equal(botOfThread(thread("t", { botId: "deleted" }), bots), null);
});
