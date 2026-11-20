import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CH } from "@deyin/contract";
import { ActivityLog, FileStorage, Outbox, SurfaceStore, XCursors, plainCipher, type AutomationRun, type BotResult, type BotSurfacesState, type DeyinBot, type SurfaceSaved } from "@deyin/host-core";
import { RunWatch } from "../src/main/bots/run-watch.js";
import { registerSurfaces, withTimeout, type SurfaceWiring } from "../src/main/bots/surface-wiring.js";

const dirs: string[] = [];
const wirings: SurfaceWiring[] = [];
after(async () => {
  await Promise.all(wirings.map((wiring) => wiring.dispose()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function rig(before?: (store: SurfaceStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "deyin-wiring-"));
  dirs.push(dir);
  const storage = new FileStorage(dir, plainCipher);
  const store = new SurfaceStore(storage, { makeKey: () => "hook-key-123" });
  store.setHubSettings({ port: await freePort() });
  before?.(store);
  const outbox = new Outbox(storage);
  const cursors = new XCursors(storage);
  const activity = new ActivityLog();
  const runs = new Map<string, AutomationRun>();
  const runWatch = new RunWatch((id) => runs.get(id));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const broadcasts: Array<[string, unknown]> = [];
  const prompts: string[] = [];
  const wiring = registerSurfaces({
    store,
    outbox,
    cursors,
    activity,
    runWatch,
    bots: { get: (id) => (id === "ada" ? ({ id } as DeyinBot) : undefined) },
    routines: { get: (id) => (id === "r1" ? { id, botId: "ada", enabled: true } : undefined) },
    invoke: (_id, text) => {
      prompts.push(text);
      return { id: `run-${prompts.length}` };
    },
    fetch: async () => {
      throw new Error("no network in this test");
    },
    handle: (channel, handler) => void handlers.set(channel, handler),
    broadcast: (channel, payload) => void broadcasts.push([channel, payload]),
    xIntervalMs: 3_600_000,
  });
  wirings.push(wiring);
  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => (await handlers.get(channel)?.(...args)) as T;
  return { store, outbox, cursors, activity, wiring, handlers, broadcasts, prompts, call };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

test("every call the Connections panel makes is registered", async () => {
  const r = await rig();
  for (const channel of [CH.botSurfacesState, CH.botSurfacesSave, CH.botSurfacesRemake, CH.botSurfacesSetEnabled, CH.botSurfacesRemove, CH.botSurfacesSetHub, CH.botSurfacesOutboxEdit, CH.botSurfacesOutboxApprove, CH.botSurfacesOutboxDeny]) {
    assert.equal(typeof r.handlers.get(channel), "function", channel);
  }
});

test("the hub is not listening until something that calls it is switched on, and stops when the last one goes", async () => {
  const r = await rig();
  assert.equal(r.wiring.hub.status().listening, false);
  const saved = await r.call<BotResult<SurfaceSaved>>(CH.botSurfacesSave, "ada", "webhook", { routineId: "r1", enabled: true });
  assert.equal(saved.ok && saved.value.generated.key, "hook-key-123");
  await settle();
  assert.equal(r.wiring.hub.status().listening, true);
  const port = r.wiring.hub.status().port;
  const answered = await fetch(`http://127.0.0.1:${port}/hooks/webhook/ada`, { method: "POST", headers: { "x-deyin-key": "hook-key-123" }, body: "deploy finished" });
  assert.equal(answered.status, 202);
  assert.match(r.prompts[0] ?? "", /deploy finished/);
  await r.call(CH.botSurfacesSetEnabled, "ada", "webhook", false);
  await settle();
  assert.equal(r.wiring.hub.status().listening, false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
});

test("X does not open a port: it asks, so an X-only Bot leaves the hub closed", async () => {
  const r = await rig();
  const saved = await r.call<BotResult<SurfaceSaved>>(CH.botSurfacesSave, "ada", "x", {
    routineId: "r1",
    enabled: true,
    allow: ["ada"],
    settings: { userId: "99", handle: "deyin_bot" },
    secrets: { accessToken: "x-access-token-1" },
  });
  assert.equal(saved.ok, true);
  await settle();
  assert.equal(r.wiring.hub.status().listening, false);
});

test("the panel is told once when several things change together, and again for later changes", async () => {
  const r = await rig();
  r.broadcasts.length = 0;
  await r.call(CH.botSurfacesSave, "ada", "webhook", { routineId: "r1", enabled: true });
  r.activity.add("ada", "webhook", "accepted", "x");
  await settle();
  assert.equal(r.broadcasts.filter(([channel]) => channel === CH.botSurfacesChanged).length, 1);
  r.activity.add("ada", "webhook", "accepted", "y");
  r.activity.add("ada", "webhook", "accepted", "z");
  await settle();
  assert.equal(r.broadcasts.filter(([channel]) => channel === CH.botSurfacesChanged).length, 2);
  r.outbox.add({ botId: "ada", inReplyTo: "5", context: "c", author: "@a", text: "t" });
  await settle();
  assert.equal(r.broadcasts.filter(([channel]) => channel === CH.botSurfacesChanged).length, 3, "a new draft in the Outbox is told too");
});

test("a port that is taken is shown in the state with a way out, and saving the same port again tries once more", async () => {
  const r = await rig();
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", () => resolve()));
  const port = (taken.address() as { port: number }).port;
  try {
    await r.call(CH.botSurfacesSave, "ada", "webhook", { routineId: "r1", enabled: true });
    await settle();
    const moved = await r.call<BotResult<{ status: { listening: boolean; error?: string } }>>(CH.botSurfacesSetHub, { port });
    assert.equal(moved.ok && moved.value.status.listening, false);
    assert.match((moved.ok && moved.value.status.error) || "", /already in use/);
    const state = await r.call<BotResult<BotSurfacesState>>(CH.botSurfacesState, "ada");
    assert.match((state.ok && state.value.hub.status.error) || "", /already in use/);
  } finally {
    await new Promise<void>((resolve) => taken.close(() => resolve()));
  }
  r.broadcasts.length = 0;
  const retry = await r.call<BotResult<{ status: { listening: boolean } }>>(CH.botSurfacesSetHub, { port });
  assert.equal(retry.ok && retry.value.status.listening, true);
  await settle();
  assert.ok(r.broadcasts.some(([channel]) => channel === CH.botSurfacesChanged), "the panel is told the port is open now");
});

test("deleting a Bot is passed to everything that remembers it: the hub, the poller and the X cursors", async () => {
  const r = await rig();
  const forgotten: string[] = [];
  const { hub, poller } = r.wiring;
  const hubForget = hub.forgetBot.bind(hub);
  const pollerForget = poller.forgetBot.bind(poller);
  const cursorForget = r.cursors.forget.bind(r.cursors);
  hub.forgetBot = (id) => (forgotten.push(`hub:${id}`), hubForget(id));
  poller.forgetBot = (id) => (forgotten.push(`poller:${id}`), pollerForget(id));
  r.cursors.forget = (id) => (forgotten.push(`cursors:${id}`), cursorForget(id));
  r.wiring.removeBot("ada");
  assert.deepEqual(forgotten.sort(), ["cursors:ada", "hub:ada", "poller:ada"]);
});

test("closing the app stops the poller as well as the hub", async () => {
  const r = await rig();
  let stopped = 0;
  const stop = r.wiring.poller.stop.bind(r.wiring.poller);
  r.wiring.poller.stop = () => (stopped += 1, stop());
  await r.wiring.dispose();
  assert.equal(stopped, 1);
  assert.equal(r.wiring.hub.status().listening, false);
});

test("a surface that was already on when the app started is served at once", async () => {
  const r = await rig((store) => {
    store.save("ada", "webhook", { routineId: "r1", enabled: true });
  });
  await settle();
  assert.equal(r.wiring.hub.status().listening, true);
});

test("deleting a Bot closes its ways in and forgets everything kept for it", async () => {
  const r = await rig();
  await r.call(CH.botSurfacesSave, "ada", "webhook", { routineId: "r1", enabled: true });
  await settle();
  r.outbox.add({ botId: "ada", inReplyTo: "1", context: "c", author: "@a", text: "t" });
  r.activity.add("ada", "webhook", "accepted");
  const port = r.wiring.hub.status().port;
  r.wiring.removeBot("ada");
  await settle();
  assert.deepEqual(r.store.list("ada"), []);
  assert.deepEqual(r.outbox.list("ada"), []);
  assert.deepEqual(r.activity.recent("ada"), []);
  assert.equal(r.wiring.hub.status().listening, false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
});

test("a call out to a service gives up on its own, and a caller's own limit is kept", async () => {
  let seen: AbortSignal | undefined;
  const wrapped = withTimeout(async (_url, init) => {
    seen = init?.signal;
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }, 50);
  await wrapped("https://example.com");
  assert.ok(seen);
  assert.equal(seen?.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(seen?.aborted, true);
  const mine = new AbortController();
  await wrapped("https://example.com", { signal: mine.signal });
  assert.equal(seen, mine.signal);
});

test("a run that ends wakes the one waiting for it, and one that was already over is answered at once", async () => {
  const runs = new Map<string, AutomationRun>();
  const watch = new RunWatch((id) => runs.get(id));
  const base = { automationId: "a", startedAt: 1, events: [] } as const;
  runs.set("live", { ...base, id: "live", status: "running" });
  const waiting = watch.settled("live");
  assert.equal(watch.pending(), 1);
  runs.set("live", { ...base, id: "live", status: "completed", finalText: "  All done.  " });
  watch.finished(runs.get("live") as AutomationRun);
  assert.deepEqual(await waiting, { status: "completed", reply: "All done." });
  assert.equal(watch.pending(), 0);
  runs.set("old", { ...base, id: "old", status: "failed", reason: "blocked: auth" });
  assert.deepEqual(await watch.settled("old"), { status: "failed", reason: "blocked: auth", reply: "" });
  assert.deepEqual(await watch.settled("never"), { status: "aborted", reason: "run not found", reply: "" });
  runs.set("q", { ...base, id: "q", status: "queued" });
  const queued = watch.settled("q");
  watch.finished({ ...base, id: "q", status: "running" });
  assert.equal(watch.pending(), 1, "starting is not ending");
  watch.finished({ ...base, id: "q", status: "aborted", reason: "stopped" });
  assert.equal((await queued).reason, "stopped");
  watch.finished({ ...base, id: "unwatched", status: "completed" });
});

test("a wait that nothing ever ends is given up on, and leaves nothing behind", async () => {
  const runs = new Map<string, AutomationRun>();
  const base = { automationId: "a", startedAt: 1, events: [] } as const;
  runs.set("stuck", { ...base, id: "stuck", status: "running" });
  const watch = new RunWatch((id) => runs.get(id), 30);
  const first = watch.settled("stuck");
  const second = watch.settled("stuck");
  assert.equal(watch.pending(), 1);
  assert.deepEqual(await first, { status: "aborted", reason: "gave up waiting", reply: "" });
  assert.deepEqual(await second, { status: "aborted", reason: "gave up waiting", reply: "" });
  assert.equal(watch.pending(), 0);
  // A run that ends in time is answered by the run, and its timer does not fire later with a second answer.
  runs.set("quick", { ...base, id: "quick", status: "running" });
  const quick = watch.settled("quick");
  runs.set("quick", { ...base, id: "quick", status: "completed", finalText: "Done." });
  watch.finished(runs.get("quick") as AutomationRun);
  assert.deepEqual(await quick, { status: "completed", reply: "Done." });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(watch.pending(), 0);
});
