import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationInfo, BotResult } from "@deyin/contract";
import { DEFAULT_HUB_SETTINGS, type BotSurfacesState, type OutboxPost, type SurfaceInput, type SurfaceKind, type SurfaceView } from "@deyin/host-core/shared";
import { createConnectionsController } from "../src/bots/botConnectionsController.js";
import type { SurfacesApi } from "../src/bots/botSurfaces.js";

const ok = <T>(value: T): BotResult<T> => ({ ok: true, value });
const no = <T>(error: string): BotResult<T> => ({ ok: false, code: "invalid", error });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function view(kind: SurfaceKind, over: Partial<SurfaceView> = {}): SurfaceView {
  return { botId: "ada", surface: kind, routineId: "r1", enabled: false, allow: [], settings: {}, createdAt: 1, updatedAt: 1, has: {}, missing: [], ...over };
}

function post(over: Partial<OutboxPost> = {}): OutboxPost {
  return { id: "p1", botId: "ada", surface: "x", inReplyTo: "10", context: "hi", author: "@a", text: "Hello", status: "pending", createdAt: 1, ...over };
}

function routine(over: Partial<AutomationInfo> = {}): AutomationInfo {
  return {
    id: "r1",
    botId: "ada",
    name: "Answer",
    enabled: true,
    payload: { kind: "prompt", prompt: "p" },
    trigger: { kind: "manual" },
    target: { kind: "local", workspacePath: "" },
    model: "m",
    providerId: "p",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function snapshot(over: Partial<BotSurfacesState> = {}): BotSurfacesState {
  return { surfaces: [], hub: { settings: DEFAULT_HUB_SETTINGS, status: { listening: false, port: DEFAULT_HUB_SETTINGS.port } }, activity: [], outbox: [], protection: "encrypted", ...over };
}

interface Rig {
  api: SurfacesApi;
  calls: Array<[string, ...unknown[]]>;
  state: { current: BotSurfacesState };
  fire(): void;
  listening(): number;
  routineListeners: Set<(list: AutomationInfo[]) => void>;
  created: unknown[];
  automations: { current: AutomationInfo[] };
  results: Record<string, () => Promise<BotResult<unknown>> | BotResult<unknown>>;
}

function rig(initial: BotSurfacesState = snapshot()): Rig {
  const calls: Array<[string, ...unknown[]]> = [];
  const state = { current: initial };
  const listeners = new Set<() => void>();
  const routineListeners = new Set<(list: AutomationInfo[]) => void>();
  const created: unknown[] = [];
  const automations = { current: [routine()] };
  const results: Rig["results"] = {};
  const answer = async <T>(name: string, fallback: BotResult<T>): Promise<BotResult<T>> => (results[name] ? ((await results[name]()) as BotResult<T>) : fallback);
  const api: SurfacesApi = {
    state: async (botId) => {
      calls.push(["state", botId]);
      return answer("state", ok(state.current));
    },
    save: async (botId, kind, input) => {
      calls.push(["save", botId, kind, input]);
      return answer("save", ok({ view: view(kind), generated: {} }));
    },
    remake: async (botId, kind, name) => {
      calls.push(["remake", botId, kind, name]);
      return answer("remake", ok({ view: view(kind), value: "fresh-value" }));
    },
    setEnabled: async (botId, kind, enabled) => {
      calls.push(["setEnabled", botId, kind, enabled]);
      return answer("setEnabled", ok(view(kind, { enabled })));
    },
    remove: async (botId, kind) => {
      calls.push(["remove", botId, kind]);
      return answer("remove", ok(null));
    },
    setHub: async (settings) => {
      calls.push(["setHub", settings]);
      return answer("setHub", ok({ settings: { ...DEFAULT_HUB_SETTINGS, ...settings }, status: { listening: true, port: 1 } }));
    },
    outboxEdit: async (id, text) => {
      calls.push(["outboxEdit", id, text]);
      return answer("outboxEdit", ok(post({ id, text })));
    },
    outboxApprove: async (id) => {
      calls.push(["outboxApprove", id]);
      return answer("outboxApprove", ok(post({ id, status: "sent" })));
    },
    outboxDeny: async (id) => {
      calls.push(["outboxDeny", id]);
      return answer("outboxDeny", ok(post({ id, status: "denied" })));
    },
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return {
    api,
    calls,
    state,
    fire: () => listeners.forEach((cb) => cb()),
    listening: () => listeners.size,
    routineListeners,
    created,
    automations,
    results,
  };
}

function make(r: Rig, routinesOver: { create?: (input: unknown) => Promise<unknown>; withOnChange?: boolean } = {}) {
  const { routineListeners } = r;
  const routines = {
    list: async () => r.automations.current,
    create: async (input: unknown) => {
      r.created.push(input);
      if (routinesOver.create) return routinesOver.create(input);
      const made = routine({ id: "r-new", name: (input as { name: string }).name });
      r.automations.current = [...r.automations.current, made];
      return { automation: made, list: r.automations.current };
    },
    ...(routinesOver.withOnChange === false
      ? {}
      : {
          onChange: (cb: (list: AutomationInfo[]) => void) => {
            routineListeners.add(cb);
            return () => routineListeners.delete(cb);
          },
        }),
  };
  const controller = createConnectionsController({ botId: "ada", api: r.api, routines: routines as never });
  const off = controller.subscribe(() => undefined);
  return { controller, off, routineListeners };
}

const DEFAULTS = { model: "m", providerId: "p" };

test("the first listener loads what the host knows and the Bot's routines; the last to leave stops listening", async () => {
  const r = rig(snapshot({ surfaces: [view("webhook")] }));
  const { controller, off, routineListeners } = make(r);
  assert.equal(controller.getState().load.status, "loading");
  await tick();
  const loaded = controller.getState();
  assert.equal(loaded.load.status, "ready");
  assert.equal(loaded.automations?.length, 1);
  assert.equal(r.listening(), 1);
  assert.equal(routineListeners.size, 1);
  off();
  assert.equal(r.listening(), 0);
  assert.equal(routineListeners.size, 0);
});

test("a failed first load says why; a failed refresh keeps what is on screen", async () => {
  const bad = rig();
  bad.results.state = () => no("The host is busy.");
  const first = make(bad);
  await tick();
  assert.deepEqual(first.controller.getState().load, { status: "error", error: "The host is busy." });

  const good = rig(snapshot({ surfaces: [view("webhook")] }));
  const { controller } = make(good);
  await tick();
  good.results.state = () => no("Try later.");
  good.fire();
  await tick();
  assert.equal(controller.getState().load.status, "ready");
  assert.equal(controller.getState().notice, "Try later.");
});

test("a load that is overtaken by a newer one is dropped", async () => {
  const r = rig(snapshot({ surfaces: [view("webhook")] }));
  let release: (value: BotResult<BotSurfacesState>) => void = () => undefined;
  let first = true;
  r.results.state = () => {
    if (first) {
      first = false;
      return new Promise<BotResult<BotSurfacesState>>((resolve) => (release = resolve));
    }
    return ok(snapshot({ surfaces: [view("webhook"), view("email")] }));
  };
  const { controller } = make(r);
  await tick();
  r.fire();
  await tick();
  const newest = controller.getState().load;
  assert.equal(newest.status === "ready" && newest.state.surfaces.length, 2);
  release(ok(snapshot()));
  await tick();
  const after = controller.getState().load;
  assert.equal(after.status === "ready" && after.state.surfaces.length, 2, "the older answer did not win");
});

test("opening a card starts from what is saved, and what is typed is kept when the host reports a change", async () => {
  const r = rig(snapshot({ surfaces: [view("slack", { allow: ["U1"], routineId: "r1", has: { signingSecret: true, botToken: true } })] }));
  const { controller } = make(r);
  await tick();
  controller.open("slack");
  assert.equal(controller.getState().forms.slack?.allow, "U1");
  controller.change("slack", { allow: "U1\nU2" });
  r.fire();
  await tick();
  assert.equal(controller.getState().forms.slack?.allow, "U1\nU2");
  controller.open("slack");
  assert.equal(controller.getState().forms.slack?.allow, "U1\nU2", "opening again does not throw the edit away");
});

test("saving sends the form with the surface's own on/off, closes the card, and holds a made key until it is copied", async () => {
  const r = rig();
  r.results.save = () => ok({ view: view("webhook"), generated: { key: "made-key-1" } });
  const { controller } = make(r);
  await tick();
  controller.open("webhook");
  controller.change("webhook", { routineId: "r1" });
  await controller.save("webhook");
  const sent = r.calls.find(([name]) => name === "save") as [string, string, string, Partial<SurfaceInput>];
  assert.deepEqual(sent.slice(1, 3), ["ada", "webhook"]);
  assert.equal(sent[3].routineId, "r1");
  assert.equal(sent[3].enabled, false, "a surface that is not set up yet is saved off");
  const after = controller.getState();
  assert.equal(after.forms.webhook, undefined);
  assert.equal(after.cards.webhook?.saved, true);
  assert.deepEqual(after.generated.webhook, { key: "made-key-1" });
  controller.dismissGenerated("webhook", "key");
  assert.equal(controller.getState().generated.webhook, undefined);
});

test("saving keeps a surface that is on, on; a refusal keeps the form and says why", async () => {
  const r = rig(snapshot({ surfaces: [view("webhook", { enabled: true })] }));
  const { controller } = make(r);
  await tick();
  controller.open("webhook");
  controller.change("webhook", { routineId: "" });
  r.results.save = () => no("Finish setting this up before turning it on.");
  await controller.save("webhook");
  const sent = r.calls.find(([name]) => name === "save") as [string, string, string, Partial<SurfaceInput>];
  assert.equal(sent[3].enabled, true);
  const state = controller.getState();
  assert.ok(state.forms.webhook, "the form is still open");
  assert.equal(state.cards.webhook?.error, "Finish setting this up before turning it on.");
  assert.equal(state.cards.webhook?.busy, false);
  controller.change("webhook", { routineId: "r1" });
  assert.equal(controller.getState().cards.webhook?.error, null, "typing clears the old refusal");
});

test("a second save while one is running does nothing", async () => {
  const r = rig();
  let release: () => void = () => undefined;
  r.results.save = () => new Promise((resolve) => (release = () => resolve(ok({ view: view("webhook"), generated: {} }))));
  const { controller } = make(r);
  await tick();
  controller.open("webhook");
  const first = controller.save("webhook");
  await controller.save("webhook");
  release();
  await first;
  assert.equal(r.calls.filter(([name]) => name === "save").length, 1);
});

test("turning a surface on or off asks the host, and a refusal is shown for the whole panel", async () => {
  const r = rig(snapshot({ surfaces: [view("webhook")] }));
  const { controller } = make(r);
  await tick();
  await controller.toggle("webhook", true);
  assert.deepEqual(r.calls.find(([name]) => name === "setEnabled"), ["setEnabled", "ada", "webhook", true]);
  r.results.setEnabled = () => no("Finish setting this up before turning it on. Still needed: allow.");
  await controller.toggle("webhook", true);
  assert.match(controller.getState().notice ?? "", /Still needed/);
  assert.equal(controller.getState().cards.webhook?.busy, false);
});

test("disconnecting forgets the form and any key still held; a refusal changes nothing", async () => {
  const r = rig(snapshot({ surfaces: [view("webhook")] }));
  r.results.save = () => ok({ view: view("webhook"), generated: { key: "k" } });
  const { controller } = make(r);
  await tick();
  controller.open("webhook");
  await controller.save("webhook");
  controller.open("webhook");
  r.results.remove = () => no("Could not.");
  await controller.remove("webhook");
  assert.equal(controller.getState().notice, "Could not.");
  assert.ok(controller.getState().forms.webhook);
  delete r.results.remove;
  await controller.remove("webhook");
  const state = controller.getState();
  assert.equal(state.forms.webhook, undefined);
  assert.equal(state.generated.webhook, undefined);
  assert.equal(state.notice, null);
});

test("a new key is held for copying; a refusal is shown on its card", async () => {
  const r = rig(snapshot({ surfaces: [view("webhook", { has: { key: true } })] }));
  const { controller } = make(r);
  await tick();
  await controller.remake("webhook", "key");
  assert.deepEqual(controller.getState().generated.webhook, { key: "fresh-value" });
  r.results.remake = () => no("Set this surface up first.");
  await controller.remake("webhook", "key");
  assert.equal(controller.getState().cards.webhook?.error, "Set this surface up first.");
});

test("a routine made for messages only runs when one arrives, and is chosen in the open form", async () => {
  const r = rig();
  const { controller } = make(r);
  await tick();
  controller.open("slack");
  await controller.makeRoutine("slack", "Answer messages", DEFAULTS);
  const input = r.created[0] as { botId: string; name: string; trigger: { kind: string }; payload: { kind: string }; model: string };
  assert.equal(input.botId, "ada");
  assert.equal(input.name, "Answer messages");
  assert.deepEqual(input.trigger, { kind: "manual" });
  assert.equal(input.payload.kind, "prompt");
  assert.equal(input.model, "m");
  const state = controller.getState();
  assert.equal(state.forms.slack?.routineId, "r-new");
  assert.equal(state.automations?.some((a) => a.id === "r-new"), true);
  assert.equal(state.cards.slack?.making, false);
});

test("a routine that could not be made says why on its card and leaves the choice alone", async () => {
  const r = rig();
  const { controller } = make(r, {
    create: async () => {
      throw new Error("A Bot can have 10 routines.");
    },
  });
  await tick();
  controller.open("slack");
  await controller.makeRoutine("slack", "Answer messages", DEFAULTS);
  const state = controller.getState();
  assert.equal(state.cards.slack?.error, "A Bot can have 10 routines.");
  assert.equal(state.forms.slack?.routineId, "");
  assert.equal(state.cards.slack?.making, false);
});

test("the Bot's routines follow changes made elsewhere, and work where they cannot be watched", async () => {
  const r = rig();
  const { controller, routineListeners } = make(r);
  await tick();
  routineListeners.forEach((cb) => cb([routine({ id: "r2", name: "Other" })]));
  assert.deepEqual(controller.getState().automations?.map((a) => a.id), ["r2"]);

  const quiet = rig();
  const unwatched = make(quiet, { withOnChange: false });
  await tick();
  assert.equal(unwatched.controller.getState().automations?.length, 1);
  unwatched.off();
});

test("address settings: typed changes are checked, saved once, and a refusal is shown", async () => {
  const r = rig();
  const { controller } = make(r);
  await tick();
  controller.changeHub({ port: "50000" });
  assert.equal(controller.getState().hub.form?.port, "50000");
  assert.equal(controller.getState().hub.form?.publicUrl, "", "the other field keeps what was saved");
  controller.changeHub({ publicUrl: "http://insecure.example" });
  await controller.saveHub();
  assert.equal(r.calls.some(([name]) => name === "setHub"), false, "an address that cannot be saved is not sent");
  assert.equal(controller.getState().hub.error, null, "and it is not reported as a refusal from the host");
  assert.equal(controller.getState().hub.busy, false);
  controller.changeHub({ publicUrl: "https://bots.example.com/" });
  r.results.setHub = () => no("The port must be a whole number from 1024 to 65535.");
  await controller.saveHub();
  assert.match(controller.getState().hub.error ?? "", /port/);
  delete r.results.setHub;
  await controller.saveHub();
  const sent = r.calls.filter(([name]) => name === "setHub").at(-1) as [string, { port: number; publicUrl: string }];
  assert.deepEqual(sent[1], { port: 50000, publicUrl: "https://bots.example.com" });
  assert.equal(controller.getState().hub.form, null);
  assert.equal(controller.getState().hub.saved, true);
});

test("trying again asks the host to listen on the saved port", async () => {
  const r = rig(snapshot({ hub: { settings: { port: 47000, publicUrl: "" }, status: { listening: false, port: 47000, error: "That port is already in use." } } }));
  const { controller } = make(r);
  await tick();
  await controller.retryHub();
  assert.deepEqual(r.calls.find(([name]) => name === "setHub"), ["setHub", { port: 47000, publicUrl: "" }]);
});

test("approving posts the words on screen: a changed draft is saved first, an unchanged one is not", async () => {
  const r = rig(snapshot({ outbox: [post()] }));
  const { controller } = make(r);
  await tick();
  controller.editPost("p1", "Hello there");
  await controller.approve(post());
  const names = r.calls.map(([name]) => name).filter((name) => name.startsWith("outbox"));
  assert.deepEqual(names, ["outboxEdit", "outboxApprove"]);
  assert.deepEqual(r.calls.find(([name]) => name === "outboxEdit"), ["outboxEdit", "p1", "Hello there"]);
  assert.equal(controller.getState().edits.p1, undefined);

  r.calls.length = 0;
  await controller.approve(post({ id: "p2" }));
  assert.deepEqual(r.calls.map(([name]) => name).filter((name) => name.startsWith("outbox")), ["outboxApprove"]);
});

test("if saving the change is refused nothing is posted, and the words typed stay", async () => {
  const r = rig(snapshot({ outbox: [post()] }));
  r.results.outboxEdit = () => no("That is longer than 280 characters. Shorten it first.");
  const { controller } = make(r);
  await tick();
  controller.editPost("p1", "x".repeat(300));
  await controller.approve(post());
  assert.equal(r.calls.some(([name]) => name === "outboxApprove"), false);
  const state = controller.getState();
  assert.match(state.outbox.errors.p1 ?? "", /Shorten/);
  assert.equal(state.edits.p1?.length, 300);
  assert.equal(state.outbox.busyId, null);
  controller.editPost("p1", "x".repeat(100));
  assert.equal(controller.getState().outbox.errors.p1, undefined, "typing clears the old refusal");
});

test("only one post is being sent at a time, and denying says no and forgets the edit", async () => {
  const r = rig(snapshot({ outbox: [post(), post({ id: "p2" })] }));
  let release: () => void = () => undefined;
  r.results.outboxApprove = () => new Promise((resolve) => (release = () => resolve(ok(post({ status: "sent" })))));
  const { controller } = make(r);
  await tick();
  const first = controller.approve(post());
  await tick();
  assert.equal(controller.getState().outbox.busyId, "p1");
  await controller.approve(post({ id: "p2" }));
  await controller.deny("p2");
  assert.equal(r.calls.filter(([name]) => name === "outboxApprove").length, 1);
  assert.equal(r.calls.some(([name]) => name === "outboxDeny"), false);
  release();
  await first;
  delete r.results.outboxApprove;
  controller.editPost("p2", "changed");
  await controller.deny("p2");
  assert.deepEqual(r.calls.find(([name]) => name === "outboxDeny"), ["outboxDeny", "p2"]);
  assert.equal(controller.getState().edits.p2, undefined);
});

test("a call that finishes after the panel was closed changes nothing", async () => {
  const r = rig();
  let release: () => void = () => undefined;
  r.results.save = () => new Promise((resolve) => (release = () => resolve(ok({ view: view("webhook"), generated: { key: "late" } }))));
  const { controller, off } = make(r);
  await tick();
  controller.open("webhook");
  const saving = controller.save("webhook");
  off();
  release();
  await saving;
  assert.equal(controller.getState().generated.webhook, undefined);
});
