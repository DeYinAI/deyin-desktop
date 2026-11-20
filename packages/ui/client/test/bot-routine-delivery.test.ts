import assert from "node:assert/strict";
import test from "node:test";
import { BOTS_PROJECT_ID, botThreads, missingTranslations, translate, type Project, type Thread } from "@deyin/host-core/shared";
import { deliverRoutineResult, routineMessage, type DeliveryWords, type FinishedRun } from "../src/bots/routineDelivery.js";

const words: DeliveryWords = { posted: "Routine: {name}", failed: 'The routine "{name}" did not finish: {reason}', noReason: "no reason was recorded" };
const done = (finalText: string | undefined): FinishedRun => ({ status: "completed", ...(finalText === undefined ? {} : { finalText }) });

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return { id, title: id, updatedAt: 1, events: [], ...over };
}
function botsProject(threads: Thread[]): Project {
  return { id: BOTS_PROJECT_ID, name: "Deyin Bot", root: null, threads };
}
const delivery = (over: Partial<Parameters<typeof deliverRoutineResult>[1]> = {}) => ({
  botId: "ada",
  name: "Morning brief",
  run: done("Three emails matter."),
  words,
  activeThreadId: null,
  now: 500,
  ...over,
});

test("a finished routine's result is posted under the routine's name", () => {
  assert.equal(routineMessage("Morning brief", done("Three emails matter.\n"), words), "**Routine: Morning brief**\n\nThree emails matter.");
});

test("a run that says nothing, was stopped, or has not finished leaves nothing in the chat", () => {
  assert.equal(routineMessage("n", done(undefined), words), null);
  assert.equal(routineMessage("n", done("   \n"), words), null);
  for (const status of ["aborted", "queued", "running"] as const) assert.equal(routineMessage("n", { status, finalText: "partial" }, words), null, status);
});

test("a run that failed says so, with why, or says no reason was recorded", () => {
  assert.equal(routineMessage("Brief", { status: "failed", reason: "The inbox would not open." }, words), 'The routine "Brief" did not finish: The inbox would not open.');
  assert.equal(routineMessage("Brief", { status: "failed" }, words), 'The routine "Brief" did not finish: no reason was recorded');
  assert.equal(routineMessage("Brief", { status: "failed", reason: "  " }, words), 'The routine "Brief" did not finish: no reason was recorded');
});

test("the result goes to the Bot's newest conversation, after what is there, and not to another Bot's", () => {
  const before = [botsProject([thread("old", { botId: "ada", updatedAt: 5 }), thread("new", { botId: "ada", updatedAt: 9, events: [{ kind: "user", text: "hi" }] }), thread("other", { botId: "bo", updatedAt: 99 })])];
  const after = deliverRoutineResult(before, delivery())!;
  const threads = after[0]!.threads;
  assert.deepEqual(threads.find((t) => t.id === "new")!.events, [{ kind: "user", text: "hi" }, { kind: "assistant", text: "**Routine: Morning brief**\n\nThree emails matter." }]);
  assert.equal(threads.find((t) => t.id === "new")!.updatedAt, 500);
  assert.deepEqual(threads.find((t) => t.id === "old")!.events, []);
  assert.deepEqual(threads.find((t) => t.id === "other")!.events, []);
});

test("the conversation is marked unread unless it is the one being looked at", () => {
  const before = [botsProject([thread("t", { botId: "ada" })])];
  assert.equal(deliverRoutineResult(before, delivery())![0]!.threads[0]!.unread, true);
  assert.equal(deliverRoutineResult(before, delivery({ activeThreadId: "t" }))![0]!.threads[0]!.unread, false);
});

test("a Bot with no conversation gets one, named for the routine, with the result in it", () => {
  const out = deliverRoutineResult([], delivery())!;
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, BOTS_PROJECT_ID);
  const [created] = botThreads(out, "ada");
  assert.equal(created!.title, "Morning brief");
  assert.equal(created!.botId, "ada");
  assert.equal(created!.unread, true);
  assert.deepEqual(created!.events, [{ kind: "assistant", text: "**Routine: Morning brief**\n\nThree emails matter." }]);
});

test("an archived conversation is not where the result goes", () => {
  const before = [botsProject([thread("gone", { botId: "ada", archived: true, updatedAt: 9 })])];
  const out = deliverRoutineResult(before, delivery())!;
  assert.deepEqual(out[0]!.threads.find((t) => t.id === "gone")!.events, []);
  assert.equal(botThreads(out, "ada").length, 1, "a new one was started instead");
});

test("with nothing to say nothing changes, and the projects given are never changed in place", () => {
  const before = [botsProject([thread("t", { botId: "ada" })])];
  assert.equal(deliverRoutineResult(before, delivery({ run: done("") })), null);
  deliverRoutineResult(before, delivery());
  assert.deepEqual(before[0]!.threads[0]!.events, []);
  assert.equal(before[0]!.threads[0]!.unread, undefined);
});

test("other projects are left as they were", () => {
  const code: Project = { id: "p1", name: "Repo", root: "/repo", threads: [thread("c", { updatedAt: 3 })] };
  const out = deliverRoutineResult([code, botsProject([thread("t", { botId: "ada" })])], delivery())!;
  assert.deepEqual(out[0], code);
});

test("the words around a result exist in every language and keep their blanks", () => {
  for (const locale of ["en", "zh", "de"] as const) {
    assert.deepEqual(missingTranslations(locale).filter((key) => key.startsWith("bot.routine.")), [], locale);
    assert.match(translate(locale, "bot.routine.posted"), /\{name\}/, locale);
    assert.match(translate(locale, "bot.routine.failed"), /\{name\}.*\{reason\}/, locale);
  }
});
