import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_BOT_LAYOUT, defaultBotAvatar, type DeyinBot } from "@deyin/host-core/shared";
import type { BotResult, BotsSnapshot } from "@deyin/contract";
import { createBotsClient, type BotsApi } from "../src/bots/botsClient.js";

function bot(id: string): DeyinBot {
  const avatar = defaultBotAvatar(id);
  return {
    id,
    name: id,
    handle: id,
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
  };
}

const snap = (...ids: string[]): BotsSnapshot => ({ bots: ids.map(bot), layout: EMPTY_BOT_LAYOUT });

interface Fake {
  api: BotsApi;
  push(snapshot: BotsSnapshot): void;
  resolveList(snapshot: BotsSnapshot): void;
  rejectList(error: Error): void;
  listeners(): number;
  calls: string[];
}

/** A host whose `list()` answers when the test says so, to exercise the push-versus-list race. */
function fake(): Fake {
  const calls: string[] = [];
  let listeners: ((s: BotsSnapshot) => void)[] = [];
  let resolve!: (s: BotsSnapshot) => void;
  let reject!: (e: Error) => void;
  const ok = async <T>(value: T): Promise<BotResult<T>> => ({ ok: true, value });
  const api: BotsApi = {
    list: () => {
      calls.push("list");
      return new Promise<BotsSnapshot>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    create: async (input) => {
      calls.push(`create:${input.name}`);
      return ok(bot(input.name));
    },
    update: async (id) => ok(bot(id)),
    archive: async (id) => ok(bot(id)),
    restore: async (id) => ok(bot(id)),
    delete: async () => {
      throw new Error("ipc went away");
    },
    setPrimary: async (id) => ok(bot(id)),
    setPinned: async () => ok(EMPTY_BOT_LAYOUT),
    setHidden: async () => ok(EMPTY_BOT_LAYOUT),
    addSection: async () => ok(EMPTY_BOT_LAYOUT),
    renameSection: async () => ok(EMPTY_BOT_LAYOUT),
    removeSection: async () => ok(EMPTY_BOT_LAYOUT),
    moveToSection: async () => ok(EMPTY_BOT_LAYOUT),
    memoryList: async () => ok([]),
    memoryForget: async () => ok(null),
    memoryShare: async () => {
      throw new Error("never called");
    },
    onChange: (cb) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
  };
  return {
    api,
    push: (s) => listeners.forEach((l) => l(s)),
    resolveList: (s) => resolve(s),
    rejectList: (e) => reject(e),
    listeners: () => listeners.length,
    calls,
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test("before the first roster arrives the state is not ready; afterwards it carries the Bots", async () => {
  const f = fake();
  const client = createBotsClient(f.api);
  assert.equal(client.getState().ready, false);
  client.subscribe(() => {});
  assert.equal(client.getState().ready, false, "subscribing alone does not fake a roster");
  f.resolveList(snap("a", "b"));
  await tick();
  const state = client.getState();
  assert.equal(state.ready, true);
  assert.deepEqual(state.bots.map((b) => b.id), ["a", "b"]);
  assert.equal(state.loadError, null);
});

test("a push replaces the roster and notifies subscribers once per change", async () => {
  const f = fake();
  const client = createBotsClient(f.api);
  let notified = 0;
  client.subscribe(() => (notified += 1));
  f.resolveList(snap("a"));
  await tick();
  assert.equal(notified, 1);
  f.push(snap("a", "b"));
  assert.equal(notified, 2);
  assert.deepEqual(client.getState().bots.map((b) => b.id), ["a", "b"]);
});

test("a push that lands before list() answers wins over the older answer", async () => {
  const f = fake();
  const client = createBotsClient(f.api);
  client.subscribe(() => {});
  f.push(snap("new"));
  f.resolveList(snap("stale"));
  await tick();
  assert.deepEqual(client.getState().bots.map((b) => b.id), ["new"]);
});

test("the state keeps its identity until something changes, so React does not re-render for nothing", async () => {
  const f = fake();
  const client = createBotsClient(f.api);
  client.subscribe(() => {});
  f.resolveList(snap("a"));
  await tick();
  assert.equal(client.getState(), client.getState());
  const before = client.getState();
  f.push(snap("a", "b"));
  assert.notEqual(client.getState(), before);
});

test("the host is only listened to while someone is subscribed, and re-subscribing works", async () => {
  const f = fake();
  const client = createBotsClient(f.api);
  assert.equal(f.listeners(), 0, "creating the client does not listen");
  const off1 = client.subscribe(() => {});
  const off2 = client.subscribe(() => {});
  assert.equal(f.listeners(), 1, "two subscribers share one host listener");
  assert.deepEqual(f.calls.filter((c) => c === "list"), ["list"], "and one list call");
  off1();
  assert.equal(f.listeners(), 1, "still one subscriber");
  off2();
  assert.equal(f.listeners(), 0);
  client.subscribe(() => {});
  assert.equal(f.listeners(), 1);
});

test("an answer that arrives after the last subscriber left is ignored", async () => {
  const f = fake();
  const client = createBotsClient(f.api);
  let notified = 0;
  const off = client.subscribe(() => (notified += 1));
  off();
  f.resolveList(snap("late"));
  await tick();
  assert.equal(notified, 0);
  assert.equal(client.getState().ready, false);
});

test("a failed load is reported, not thrown, and the roster stays empty", async () => {
  const f = fake();
  const client = createBotsClient(f.api);
  client.subscribe(() => {});
  f.rejectList(new Error("disk unreadable"));
  await tick();
  const state = client.getState();
  assert.equal(state.ready, true);
  assert.equal(state.loadError, "disk unreadable");
  assert.deepEqual(state.bots, []);
});

test("a later push clears an earlier load error", async () => {
  const f = fake();
  const client = createBotsClient(f.api);
  client.subscribe(() => {});
  f.rejectList(new Error("boom"));
  await tick();
  f.push(snap("a"));
  assert.equal(client.getState().loadError, null);
  assert.equal(client.getState().bots.length, 1);
});

test("an action that throws becomes a refusal with the message, never an unhandled rejection", async () => {
  const client = createBotsClient(fake().api);
  const result = await client.actions.delete("a");
  assert.deepEqual(result, { ok: false, code: "invalid", error: "ipc went away" });
});

test("an action that succeeds passes the host's result through untouched", async () => {
  const f = fake();
  const client = createBotsClient(f.api);
  const result = await client.actions.create({ name: "Ada" });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, ["create:Ada"]);
});

test("a host without Bots is ready and empty at once, and refuses every change in words", async () => {
  const client = createBotsClient(undefined);
  assert.deepEqual(client.getState(), { ready: true, bots: [], layout: EMPTY_BOT_LAYOUT, loadError: null });
  const off = client.subscribe(() => {});
  off();
  const refused = await client.actions.create({ name: "Ada" });
  assert.deepEqual(refused, { ok: false, code: "invalid", error: "Bots need the Deyin Desktop app." });
  assert.deepEqual(await client.actions.list(), { bots: [], layout: EMPTY_BOT_LAYOUT });
  assert.equal(typeof client.actions.onChange(() => {}), "function");
});
