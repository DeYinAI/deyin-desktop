import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotError, BotStore, FileStorage, TEACH_LIMITS, type TeachEvent } from "@deyin/host-core";
import { BotSkillStores } from "../src/main/bots/skills-handlers.js";
import type { CaptureHandle } from "../src/main/bots/teach-capture.js";
import { createTeachHandlers, type TeachState } from "../src/main/bots/teach-handlers.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { startFails?: string; savedThrows?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deyin-teach-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const stores = new BotSkillStores(store);
  const clock = { now: 1_000_000 };
  const states: TeachState[] = [];
  const saved: string[] = [];
  const captures: Array<{ handle: CaptureHandle; emit: (event: TeachEvent) => void; started: number; stopped: number }> = [];
  const handlers = createTeachHandlers({
    store,
    stores,
    now: () => clock.now,
    onChange: (state) => states.push(state),
    saved: (botId) => {
      if (options.savedThrows) throw new Error("the bridge is down");
      saved.push(botId);
    },
    capture: (onEvent) => {
      const record = { handle: undefined as unknown as CaptureHandle, emit: onEvent, started: 0, stopped: 0 };
      record.handle = {
        start: () => {
          record.started += 1;
          if (options.startFails) throw new BotError("conflict", options.startFails);
        },
        stop: async () => {
          record.stopped += 1;
        },
      };
      captures.push(record);
      return record.handle;
    },
  });
  const ada = store.create({ name: "Ada" });
  return { dir, store, stores, clock, states, saved, captures, handlers, ada };
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: string; code: string }): T {
  assert.ok(result.ok, result.ok ? "" : `${result.code}: ${result.error}`);
  return (result as { ok: true; value: T }).value;
}

function refused(result: { ok: true; value: unknown } | { ok: false; error: string; code: string }, code: string): string {
  assert.equal(result.ok, false, "expected a refusal");
  if (result.ok) return "";
  assert.equal(result.code, code, result.error);
  return result.error;
}

test("nothing is recording until it is started", () => {
  const t = setup();
  assert.deepEqual(t.handlers.state(), { recording: false, steps: 0, full: false, secretsOmitted: 0 });
});

test("starting watches the browser, says whom it is for, and counts what is kept as it comes", async () => {
  const t = setup();
  const started = ok(await t.handlers.start(t.ada.id, "  Download the weekly report "));
  assert.deepEqual(started, { recording: true, botId: t.ada.id, title: "Download the weekly report", steps: 0, full: false, secretsOmitted: 0 });
  assert.equal(t.captures[0]!.started, 1);
  t.captures[0]!.emit({ kind: "open", url: "https://example.com/reports?x=1", title: "Reports" });
  t.captures[0]!.emit({ kind: "click", target: 'button "Export"' });
  const now = t.handlers.state();
  assert.equal(now.steps, 2);
  assert.equal(now.last, 'Click button "Export".');
  assert.deepEqual(t.states.map((state) => state.steps), [0, 1, 2], "the window is told after each step that was kept");
});

test("an event that adds nothing (a blank click, a repeated page) does not tell the window anything", async () => {
  const t = setup();
  ok(await t.handlers.start(t.ada.id, "Task"));
  const before = t.states.length;
  t.captures[0]!.emit({ kind: "click", target: "   " });
  t.captures[0]!.emit({ kind: "open", url: "javascript:void(0)" });
  assert.equal(t.states.length, before);
});

test("what is typed into a secret field is counted, never kept or shown", async () => {
  const t = setup();
  ok(await t.handlers.start(t.ada.id, "Sign in"));
  t.captures[0]!.emit({ kind: "type", target: "Password", text: "hunter2" });
  const state = t.handlers.state();
  assert.equal(state.secretsOmitted, 1);
  assert.equal(JSON.stringify([state, t.states]).includes("hunter2"), false);
  assert.match(state.last ?? "", /from the Vault/);
});

test("only one recording at a time, and a second start is refused without disturbing the first", async () => {
  const t = setup();
  ok(await t.handlers.start(t.ada.id, "First"));
  t.captures[0]!.emit({ kind: "click", target: "A" });
  assert.match(refused(await t.handlers.start(t.ada.id, "Second"), "conflict"), /already running/);
  assert.equal(t.captures.length, 1, "no second watcher was made to start");
  assert.equal(t.handlers.state().title, "First");
  assert.equal(t.handlers.state().steps, 1);
});

test("two starts at the same moment make one recording", async () => {
  const t = setup();
  const [a, b] = await Promise.all([t.handlers.start(t.ada.id, "One"), t.handlers.start(t.ada.id, "Two")]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal(t.captures.length, 1);
});

test("a start that cannot watch the browser says why and leaves nothing running, so the next start works", async () => {
  const t = setup({ startFails: "Open the Browser tab and go to the page where the task starts, then begin." });
  assert.match(refused(await t.handlers.start(t.ada.id, "Task"), "conflict"), /Open the Browser tab/);
  assert.equal(t.handlers.state().recording, false);
  assert.deepEqual(t.states, [], "the window is not told there is a recording");
  const again = await t.handlers.start(t.ada.id, "Task");
  assert.equal(again.ok, false);
  assert.equal(t.captures.length, 2, "a new attempt was made, not blocked by the failed one");
});

test("a recording needs a Bot that exists, is not a room, and a name for the task; everything is checked", async () => {
  const t = setup();
  refused(await t.handlers.start("nope", "Task"), "not_found");
  const bo = t.store.create({ name: "Bo" });
  const room = t.store.create({ name: "Room", kind: "room", memberBotIds: [t.ada.id, bo.id] });
  assert.match(refused(await t.handlers.start(room.id, "Task"), "invalid"), /is a room/);
  assert.match(refused(await t.handlers.start(t.ada.id, "   "), "invalid"), /Say what the task is called/);
  for (const bad of [undefined, null, 5, {}]) {
    refused(await t.handlers.start(bad, "Task"), "invalid");
    refused(await t.handlers.start(t.ada.id, bad), "invalid");
  }
  assert.equal(t.captures.length, 0, "nothing was watched for a refused start");
  assert.equal(t.handlers.state().recording, false);
});

test("a long name for the task is cut to what a skill title can hold", async () => {
  const t = setup();
  const state = ok(await t.handlers.start(t.ada.id, "x".repeat(500)));
  assert.equal(state.title!.length, TEACH_LIMITS.title);
});

test("a note the person says while they work is a step; with no recording, or nothing in it, it is refused", async () => {
  const t = setup();
  assert.match(refused(t.handlers.note("hello"), "conflict"), /no recording/);
  ok(await t.handlers.start(t.ada.id, "Task"));
  const state = ok(t.handlers.note("  wait for the download  "));
  assert.equal(state.steps, 1);
  assert.equal(state.last, "Note from the person: wait for the download");
  refused(t.handlers.note("   "), "invalid");
  for (const bad of [undefined, null, 5, {}]) refused(t.handlers.note(bad), "invalid");
  assert.equal(t.handlers.state().steps, 1);
});

test("stopping ends the watching and gives a draft to read, with how many steps and what to know about it", async () => {
  const t = setup();
  ok(await t.handlers.start(t.ada.id, "Download the weekly report"));
  const c = t.captures[0]!;
  c.emit({ kind: "open", url: "https://example.com/login?next=/reports", title: "Login" });
  c.emit({ kind: "type", target: "Email", text: "ada@example.com" });
  c.emit({ kind: "type", target: "Password", text: "hunter2" });
  c.emit({ kind: "click", target: 'button "Sign in"' });
  const draft = ok(await t.handlers.stop());
  assert.equal(c.stopped, 1);
  assert.equal(draft.steps, 4);
  assert.equal(draft.skill.name, "download-the-weekly-report");
  assert.match(draft.skill.body, /1\. Open https:\/\/example\.com\/login \(the page is called "Login"\)\./);
  assert.match(draft.skill.body, /3\. Fill in Password from the Vault/);
  assert.equal(JSON.stringify(draft).includes("hunter2") || draft.skill.body.includes("next="), false);
  assert.deepEqual(draft.warnings, ["1 typed value was left out because it looked like a secret. The draft says to use the Vault instead."]);
  assert.equal(t.handlers.state().recording, false);
  assert.equal(t.states.at(-1)?.recording, false, "the window is told it ended");
  assert.equal((await t.stores.of(t.ada.id).list()).length, 0, "nothing is saved until the person has read it");
});

test("the person's own name and description for the skill are used when they gave them", async () => {
  const t = setup();
  ok(await t.handlers.start(t.ada.id, "Task"));
  t.captures[0]!.emit({ kind: "open", url: "https://example.com" });
  const draft = ok(await t.handlers.stop({ name: "Weekly Export", description: "Export the weekly numbers." }));
  assert.equal(draft.skill.name, "weekly-export");
  assert.equal(draft.skill.description, "Export the weekly numbers.");
  ok(await t.handlers.start(t.ada.id, "Task two"));
  t.captures[1]!.emit({ kind: "open", url: "https://example.com" });
  const plain = ok(await t.handlers.stop({ name: "  ", description: 5 }));
  assert.equal(plain.skill.name, "task-two", "blank or wrong choices fall back to the title");
  ok(await t.handlers.start(t.ada.id, "Task three"));
  t.captures[2]!.emit({ kind: "open", url: "https://example.com" });
  refused(await t.handlers.stop([1]), "invalid");
  assert.equal(t.handlers.state().recording, true, "a malformed request does not cost the person their recording");
  assert.equal(ok(await t.handlers.stop()).steps, 1, "and a proper one still gets the draft");
});

test("stopping with nothing recorded says to start again, and the recording is over anyway", async () => {
  const t = setup();
  ok(await t.handlers.start(t.ada.id, "Task"));
  assert.match(refused(await t.handlers.stop(), "invalid"), /Nothing was recorded\. Start again/);
  assert.equal(t.captures[0]!.stopped, 1);
  assert.equal(t.handlers.state().recording, false);
  assert.match(refused(await t.handlers.stop(), "conflict"), /no recording to stop/);
});

test("cancelling throws the recording away and stops watching; cancelling when nothing is recording is fine", async () => {
  const t = setup();
  assert.deepEqual(ok(await t.handlers.cancel()), { recording: false, steps: 0, full: false, secretsOmitted: 0 });
  ok(await t.handlers.start(t.ada.id, "Task"));
  t.captures[0]!.emit({ kind: "click", target: "A" });
  assert.equal(ok(await t.handlers.cancel()).recording, false);
  assert.equal(t.captures[0]!.stopped, 1);
  assert.equal(t.handlers.state().steps, 0);
  assert.equal(t.states.at(-1)?.recording, false);
  const next = ok(await t.handlers.start(t.ada.id, "Fresh"));
  assert.equal(next.steps, 0, "a new recording starts empty");
});

test("what a watcher says after its recording ended is not added to the next one", async () => {
  const t = setup();
  ok(await t.handlers.start(t.ada.id, "First"));
  const stale = t.captures[0]!;
  ok(await t.handlers.cancel());
  ok(await t.handlers.start(t.ada.id, "Second"));
  stale.emit({ kind: "click", target: "From the old watcher" });
  assert.equal(t.handlers.state().steps, 0);
  assert.equal(t.handlers.state().title, "Second");
});

test("a recording that reaches the most steps says it is full, and a draft says it was cut short", async () => {
  const t = setup();
  ok(await t.handlers.start(t.ada.id, "Long task"));
  const c = t.captures[0]!;
  c.emit({ kind: "open", url: "https://example.com" });
  for (let n = 0; n < TEACH_LIMITS.steps + 5; n += 1) c.emit({ kind: "click", target: `Button ${n}` });
  assert.equal(t.handlers.state().steps, TEACH_LIMITS.steps);
  assert.equal(t.handlers.state().full, true);
  const draft = ok(await t.handlers.stop());
  assert.equal(draft.steps, TEACH_LIMITS.steps);
  assert.match(draft.warnings[0]!, /cut short/);
});

test("a recording that runs past the time allowed stops keeping steps", async () => {
  const t = setup();
  ok(await t.handlers.start(t.ada.id, "Slow task"));
  t.captures[0]!.emit({ kind: "click", target: "Early" });
  t.clock.now += TEACH_LIMITS.durationMs + 1;
  t.captures[0]!.emit({ kind: "click", target: "Too late" });
  assert.equal(t.handlers.state().steps, 1);
  assert.equal(t.handlers.state().full, true);
});

test("a failure telling the window about a step does not stop the recording", async () => {
  const t = setup();
  const handlers = createTeachHandlers({
    store: t.store,
    stores: t.stores,
    capture: (onEvent) => {
      t.captures.push({ handle: undefined as never, emit: onEvent, started: 0, stopped: 0 });
      return { start: () => undefined, stop: async () => undefined };
    },
    onChange: () => {
      throw new Error("the window is gone");
    },
  });
  ok(await handlers.start(t.ada.id, "Task"));
  t.captures[0]!.emit({ kind: "click", target: "A" });
  assert.equal(handlers.state().steps, 1);
});

/* Saving the draft ----------------------------------------------------------------------- */

test("a draft the person has read is saved as a skill that says it came from a recording, under a name that is free", async () => {
  const t = setup();
  const draft = { name: "weekly-report", description: "Download the weekly report", body: "1. Open the page" };
  const first = ok(await t.handlers.save(t.ada.id, draft));
  assert.deepEqual([first.name, first.origin, first.version], ["weekly-report", "recording", 1]);
  const second = ok(await t.handlers.save(t.ada.id, { ...draft, body: "1. A different way" }));
  assert.equal(second.name, "weekly-report-2", "never over another skill");
  assert.equal((await t.stores.of(t.ada.id).get("weekly-report")).body, "1. Open the page");
  const third = ok(await t.handlers.save(t.ada.id, { ...draft, name: "Weekly Report!" }));
  assert.equal(third.name, "weekly-report-3");
  assert.deepEqual(t.saved, [t.ada.id, t.ada.id, t.ada.id], "each save is announced for its Bot");
});

test("a failure telling others about a saved skill does not undo or hide the save", async () => {
  const t = setup({ savedThrows: true });
  const saved = ok(await t.handlers.save(t.ada.id, { name: "weekly-report", description: "d", body: "1. Open the page" }));
  assert.equal(saved.name, "weekly-report");
  assert.deepEqual((await t.stores.of(t.ada.id).list()).map((s) => s.name), ["weekly-report"]);
});

test("a draft that is not a skill, or a Bot that is gone, is refused and saves nothing", async () => {
  const t = setup();
  for (const bad of [undefined, null, 5, "x", [], { name: "x" }, { name: "x", description: "d" }, { name: "x", description: "", body: "b" }, { name: "x", description: "d", body: 5 }]) {
    const result = await t.handlers.save(t.ada.id, bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
  refused(await t.handlers.save("nope", { name: "x", description: "d", body: "b" }), "not_found");
  refused(await t.handlers.save(undefined, { name: "x", description: "d", body: "b" }), "invalid");
  assert.deepEqual(await t.stores.of(t.ada.id).list(), []);
  assert.deepEqual(t.saved, [], "a refused save is not announced");
});
