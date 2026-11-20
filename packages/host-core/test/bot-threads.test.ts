import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOTS_PROJECT_ID,
  BOTS_PROJECT_NAME,
  addBotThread,
  botThreads,
  isBotsProject,
  removeBotThreads,
  visibleProjects,
  type Project,
  type Thread,
} from "../src/shared.js";

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return { id, title: id, updatedAt: 1, events: [], ...over };
}

function project(id: string, threads: Thread[] = [], root: string | null = `/work/${id}`): Project {
  return { id, name: id, root, threads };
}

test("only the reserved id is the Bots project, whatever a folder project is called", () => {
  assert.equal(isBotsProject({ id: BOTS_PROJECT_ID }), true);
  assert.equal(isBotsProject({ id: "bots" }), false);
  assert.equal(isBotsProject({ id: "Deyin Bot" }), false);
});

test("Code and Conductor never see the Bots project", () => {
  const list = [project("a"), project(BOTS_PROJECT_ID, [thread("t", { botId: "b" })], null), project("c")];
  assert.deepEqual(visibleProjects(list).map((p) => p.id), ["a", "c"]);
  assert.equal(visibleProjects([]).length, 0);
});

test("the first Bot conversation creates the Bots project last, so the first workspace stays first", () => {
  const first = thread("t1", { botId: "b1" });
  const out = addBotThread([project("a"), project("c")], first);
  assert.deepEqual(out.map((p) => p.id), ["a", "c", BOTS_PROJECT_ID]);
  const created = out[2]!;
  assert.equal(created.root, null, "it is folder-less");
  assert.equal(created.name, BOTS_PROJECT_NAME);
  assert.deepEqual(created.threads, [first]);
});

test("the project a first conversation creates is one every Bots rule recognises: hidden from Code, and found again for its Bot", () => {
  const out = addBotThread([], thread("t1", { botId: "b1" }));
  assert.equal(out.length, 1);
  assert.equal(isBotsProject(out[0]!), true);
  assert.deepEqual(visibleProjects(out), []);
  assert.deepEqual(botThreads(out, "b1").map((t) => t.id), ["t1"]);
  assert.equal(addBotThread.length, 2, "the project's id is not a choice for the caller");
});

test("later conversations go first in the existing Bots project and nothing else changes", () => {
  const a = project("a", [thread("code")]);
  const before = addBotThread([a], thread("t1", { botId: "b1" }));
  const t2 = thread("t2", { botId: "b2" });
  const after = addBotThread(before, t2);
  assert.deepEqual(after[1]!.threads.map((t) => t.id), ["t2", "t1"]);
  assert.equal(after[0], a, "other projects are the same objects");
  assert.equal(after.length, 2, "no second Bots project");
});

test("a conversation without a Bot is refused, so a Code chat can never be hidden by the Bots rules", () => {
  assert.throws(() => addBotThread([], thread("t")), /needs a botId/);
});

test("addBotThread does not mutate its input", () => {
  const list = [project("a")];
  addBotThread(list, thread("t", { botId: "b" }));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.threads.length, 0);
});

test("botThreads returns one Bot's live conversations, newest first", () => {
  const list = addBotThread(
    addBotThread(
      addBotThread([project("a")], thread("old", { botId: "b1", updatedAt: 10 })),
      thread("other", { botId: "b2", updatedAt: 50 }),
    ),
    thread("new", { botId: "b1", updatedAt: 30 }),
  );
  assert.deepEqual(botThreads(list, "b1").map((t) => t.id), ["new", "old"]);
  assert.deepEqual(botThreads(list, "b2").map((t) => t.id), ["other"]);
  assert.deepEqual(botThreads(list, "nobody"), []);
});

test("archived conversations are not listed, and a missing Bots project lists nothing", () => {
  const list = addBotThread([project("a")], thread("gone", { botId: "b1", archived: true }));
  assert.deepEqual(botThreads(list, "b1"), []);
  assert.deepEqual(botThreads([project("a")], "b1"), []);
});

test("a Bot thread filed in an ordinary project is not found: only the Bots project holds them", () => {
  const stray = project("a", [thread("t", { botId: "b1" })]);
  assert.deepEqual(botThreads([stray], "b1"), []);
});

test("deleting a Bot removes only its conversations", () => {
  const list = addBotThread(
    addBotThread([project("a", [thread("code")])], thread("t1", { botId: "b1" })),
    thread("t2", { botId: "b2" }),
  );
  const out = removeBotThreads(list, "b1");
  assert.deepEqual(out.find(isBotsProject)!.threads.map((t) => t.id), ["t2"]);
  assert.equal(out[0], list[0], "Code projects are untouched");
});

test("deleting a Bot with no conversations returns the very same array", () => {
  const list = addBotThread([project("a")], thread("t", { botId: "b1" }));
  assert.equal(removeBotThreads(list, "b9"), list);
  assert.equal(removeBotThreads([project("a")], "b1").length, 1);
});

test("deleting a Bot never touches a Code thread that happens to share a title", () => {
  const code = thread("same-title", { title: "t1" });
  const list = addBotThread([project("a", [code])], thread("t1", { botId: "b1" }));
  assert.equal(removeBotThreads(list, "b1")[0]!.threads[0], code);
});
