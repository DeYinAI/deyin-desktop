import assert from "node:assert/strict";
import test from "node:test";
import { missingTranslations, translate, type EngineHostView, type EngineSetupEvent, type EngineStatusView, type MessageKey, type RoutineServerView } from "@deyin/host-core/shared";
import {
  LOCAL_PLACE,
  ROW_STATE_KEY,
  STEP_STATE_KEY,
  attemptServerList,
  attemptServers,
  cleanSignInCode,
  dismissSetup,
  placeChoices,
  placeHealth,
  placeNotes,
  placePatch,
  placeValue,
  reduceSetup,
  routineServerLine,
  safeSignInUrl,
  serverRow,
  sortServers,
  statusProblem,
  stepLabelKey,
  type SetupViews,
} from "../src/bots/botServers.js";

const host = (over: Partial<EngineHostView> = {}): EngineHostView => ({ hostId: "h1", label: "Dell", address: "anh@dell", pinned: true, bots: 0, ...over });
const engine = { port: 7790, supervisor: "systemd" as const, survivesReboot: true, installedAt: 1, connected: false };

/* Talking to the host ----------------------------------------------------- */

test("a call that works gives its value, one that is refused gives the words, and one that throws is not thrown", async () => {
  assert.deepEqual(await attemptServers(async () => ({ ok: true, value: 5 })), { ok: true, value: 5 });
  assert.deepEqual(await attemptServers(async () => ({ ok: false, error: "Could not connect to Dell", code: "conflict" })), { ok: false, error: "Could not connect to Dell" });
  assert.deepEqual(await attemptServers(async () => Promise.reject(new Error("ipc closed"))), { ok: false, error: "ipc closed" });
  assert.deepEqual(await attemptServers(async () => Promise.reject("plain text")), { ok: false, error: "plain text" });
  assert.deepEqual(await attemptServerList({ list: async () => [host()] }), { ok: true, value: [host()] });
  assert.deepEqual(await attemptServerList({ list: async () => Promise.reject(new Error("gone")) }), { ok: false, error: "gone" });
});

/* Sign-in ------------------------------------------------------------------ */

test("a sign-in link from the server is opened only if it is a plain https link", () => {
  assert.equal(safeSignInUrl("https://openference.com/device?user_code=ABCD-EFGH"), "https://openference.com/device?user_code=ABCD-EFGH");
  for (const bad of ["http://openference.com/device", "javascript:alert(1)", "file:///etc/passwd", "ssh://x@y", "https://user:pw@openference.com/", "https://user@openference.com/", "not a url", "", "//openference.com"]) {
    assert.equal(safeSignInUrl(bad), null, bad);
  }
  assert.equal(safeSignInUrl("https:///openference.com/device"), "https://openference.com/device", "a spelling the browser reads as a plain https link is shown the way the browser reads it");
});

test("a code from the server is shown as letters, digits, dashes and spaces only, and not at length", () => {
  assert.equal(cleanSignInCode("ABCD-EFGH"), "ABCD-EFGH");
  assert.equal(cleanSignInCode("  AB CD \u001b[0m"), "AB CD 0m");
  assert.equal(cleanSignInCode("<b>ABCD</b>"), "bABCDb");
  assert.equal(cleanSignInCode("x".repeat(100)).length, 40);
  assert.equal(cleanSignInCode("\u0007\u001b"), "");
});

/* Setup progress ------------------------------------------------------------ */

const step = (hostId: string, name: string, state: "running" | "done" | "skipped", message = name): EngineSetupEvent => ({ type: "step", hostId, step: name, state, message });

function play(...events: EngineSetupEvent[]): SetupViews {
  return events.reduce<SetupViews>((views, event) => reduceSetup(views, event), {});
}

test("steps are listed in the order they began, and each is updated in place", () => {
  const views = play(step("h1", "probe", "running"), step("h1", "probe", "done", "anh on Linux"), step("h1", "cli", "skipped"), step("h1", "key", "running"));
  assert.deepEqual(views["h1"]!.steps, [
    { step: "probe", state: "done", message: "anh on Linux" },
    { step: "cli", state: "skipped", message: "cli" },
    { step: "key", state: "running", message: "key" },
  ]);
  assert.equal(views["h1"]!.finished, null);
});

test("each server has its own setup", () => {
  const views = play(step("h1", "probe", "running"), step("h2", "probe", "done"));
  assert.equal(views["h1"]!.steps[0]!.state, "running");
  assert.equal(views["h2"]!.steps[0]!.state, "done");
});

test("the sign-in the server asks for is shown while its step runs, and gone when that step is over", () => {
  const asked: EngineSetupEvent = { type: "sign-in", hostId: "h1", url: "https://openference.com/device?user_code=AB", code: "AB-CD" };
  let views = play(step("h1", "sign-in", "running"), asked);
  assert.deepEqual(views["h1"]!.signIn, { url: "https://openference.com/device?user_code=AB", code: "AB-CD" });
  views = reduceSetup(views, step("h1", "key", "running"));
  assert.ok(views["h1"]!.signIn, "another step starting does not end the sign-in");
  views = reduceSetup(views, step("h1", "sign-in", "done"));
  assert.equal(views["h1"]!.signIn, null);
  assert.equal(play(step("h1", "sign-in", "running"), asked, step("h1", "sign-in", "skipped"))["h1"]!.signIn, null);
});

test("a link that is not safe to open is not kept, though the code is still shown", () => {
  const views = play({ type: "sign-in", hostId: "h1", url: "javascript:alert(1)", code: "AB-CD\u001b[0m" });
  assert.deepEqual(views["h1"]!.signIn, { url: null, code: "AB-CD0m" });
});

test("finishing records how it went and ends any sign-in", () => {
  const ok = play({ type: "sign-in", hostId: "h1", url: "https://a.example/", code: "1" }, { type: "finished", hostId: "h1", ok: true, version: "1.4.0", warnings: ["no cron"] });
  assert.deepEqual(ok["h1"]!.finished, { ok: true, version: "1.4.0", warnings: ["no cron"] });
  assert.equal(ok["h1"]!.signIn, null);
  const failed = play(step("h1", "cli", "running"), { type: "finished", hostId: "h1", ok: false, message: "download failed" });
  assert.deepEqual(failed["h1"]!.finished, { ok: false, message: "download failed" });
  assert.equal(failed["h1"]!.steps.length, 1, "what was done stays visible");
});

test("a report after a setup has finished begins a new one", () => {
  const views = play(step("h1", "probe", "done"), { type: "finished", hostId: "h1", ok: false, message: "boom" }, step("h1", "probe", "running"));
  assert.deepEqual(views["h1"]!.steps, [{ step: "probe", state: "running", message: "probe" }]);
  assert.equal(views["h1"]!.finished, null);
});

test("the views are never changed in place", () => {
  const before = play(step("h1", "probe", "running"));
  const snapshot = JSON.stringify(before);
  reduceSetup(before, step("h1", "probe", "done"));
  reduceSetup(before, { type: "finished", hostId: "h1", ok: true, version: "1", warnings: [] });
  assert.equal(JSON.stringify(before), snapshot);
});

test("closing a finished setup removes it, and one still running stays", () => {
  const finished = play(step("h1", "probe", "done"), { type: "finished", hostId: "h1", ok: true, version: "1", warnings: [] }, step("h2", "probe", "running"));
  const closed = dismissSetup(finished, "h1");
  assert.equal("h1" in closed, false);
  assert.ok("h2" in closed);
  assert.equal(dismissSetup(finished, "h2"), finished, "a running one is left alone");
  assert.equal(dismissSetup(finished, "nope"), finished);
});

test("each setup step has a name, and an unknown one has none so its own words show", () => {
  for (const name of ["probe", "cli", "sign-in", "key", "start", "verify"]) assert.notEqual(stepLabelKey(name), null, name);
  assert.equal(stepLabelKey("something-new"), null);
  assert.equal(stepLabelKey("constructor"), null, "not a property of every object");
  assert.equal(stepLabelKey("__proto__"), null);
  assert.deepEqual(Object.keys(STEP_STATE_KEY).sort(), ["done", "running", "skipped"]);
});

/* A server row --------------------------------------------------------------- */

test("a server's row says what can be done with it", () => {
  assert.deepEqual(serverRow(host({ pinned: false })), { state: "needs-pin", canInstall: false, canCheck: false, canRemove: false, canForget: false, canCancel: false });
  assert.deepEqual(serverRow(host()), { state: "not-installed", canInstall: true, canCheck: false, canRemove: false, canForget: false, canCancel: false });
  assert.deepEqual(serverRow(host({ engine })), { state: "installed", canInstall: true, canCheck: true, canRemove: true, canForget: true, canCancel: false });
  assert.deepEqual(serverRow(host({ engine, busy: "installing" })), { state: "installing", canInstall: false, canCheck: false, canRemove: false, canForget: false, canCancel: true });
  assert.deepEqual(serverRow(host({ busy: "removing", engine })), { state: "removing", canInstall: false, canCheck: false, canRemove: false, canForget: false, canCancel: true });
  assert.equal(serverRow(host({ pinned: false, busy: "installing" })).state, "installing", "busy wins");
  assert.equal(serverRow(host({ pinned: false, engine })).state, "installed", "an engine already there is shown whatever the key");
});

test("every row state has words", () => {
  assert.deepEqual(Object.keys(ROW_STATE_KEY).sort(), ["installed", "installing", "needs-pin", "not-installed", "removing"]);
});

test("servers with an engine come first, the rest keep their order, and the list is not changed", () => {
  const list = [host({ hostId: "a" }), host({ hostId: "b", engine }), host({ hostId: "c" }), host({ hostId: "d", engine })];
  assert.deepEqual(sortServers(list).map((entry) => entry.hostId), ["b", "d", "a", "c"]);
  assert.deepEqual(list.map((entry) => entry.hostId), ["a", "b", "c", "d"]);
});

const status = (over: Partial<EngineStatusView> = {}): EngineStatusView => ({ version: "1", startedAt: 1, agentFound: true, signedIn: true, runningNow: 0, bots: [], ...over });

test("an engine whose agent is missing or signed out is said to be unable to run Bots", () => {
  assert.equal(statusProblem(status()), null);
  assert.equal(statusProblem(status({ agentFound: false, signedIn: false })), "servers.status.noAgent");
  assert.equal(statusProblem(status({ signedIn: false })), "servers.status.signedOut");
});

/* Where a Bot runs ------------------------------------------------------------ */

const local = { harness: "local" as const, hostId: undefined };
const onServer = (hostId: string) => ({ harness: "server" as const, hostId });

test("the choice always has this computer first, then each server, saying why one cannot be chosen", () => {
  const choices = placeChoices([host({ hostId: "a", label: "Dell", engine }), host({ hostId: "b", label: "Pi" }), host({ hostId: "c", label: "Old", pinned: false })], local);
  assert.deepEqual(choices, [
    { value: "local", label: null, unavailable: null },
    { value: "server:a", label: "Dell", unavailable: null },
    { value: "server:b", label: "Pi", unavailable: "bot.place.noEngine" },
    { value: "server:c", label: "Old", unavailable: "bot.place.notPinned" },
  ]);
});

test("a Bot set to a server that is no longer saved still shows where it is set to run", () => {
  const choices = placeChoices([host({ hostId: "a", engine })], onServer("gone"));
  assert.deepEqual(choices.at(-1), { value: "server:gone", label: null, unavailable: "bot.place.missing" });
  assert.equal(placeValue(onServer("gone")), "server:gone");
  assert.equal(placeChoices([host({ hostId: "a", engine })], onServer("a")).length, 2, "a saved server is not listed twice");
});

test("where a Bot runs now is a value the choice can hold", () => {
  assert.equal(placeValue(local), LOCAL_PLACE);
  assert.equal(placeValue(onServer("h1")), "server:h1");
  assert.equal(placeValue({ harness: "server", hostId: undefined }), LOCAL_PLACE, "a server Bot with no server shows as here rather than as nothing");
});

test("a place chosen becomes the change to save, and a value that names nothing changes nothing", () => {
  assert.deepEqual(placePatch("local"), { harness: "local" });
  assert.deepEqual(placePatch("server:h1"), { harness: "server", hostId: "h1" });
  assert.deepEqual(placePatch("server:with:colons"), { harness: "server", hostId: "with:colons" });
  for (const bad of ["", "server:", "elsewhere", "Local", "servers:h1"]) assert.equal(placePatch(bad), null, bad);
});

test("what to know about a place: nothing for this computer; for a server, what stays and what is limited", () => {
  assert.deepEqual(placeNotes({ harness: "local", autoReview: { approvalMode: "auto_review" } }), []);
  assert.deepEqual(placeNotes({ harness: "server", autoReview: { approvalMode: "read_only" } }), ["bot.place.filesStay", "bot.place.limits"]);
  assert.deepEqual(placeNotes({ harness: "server", autoReview: { approvalMode: "run_everything" } }), ["bot.place.filesStay", "bot.place.limits"]);
  assert.deepEqual(placeNotes({ harness: "server", autoReview: { approvalMode: "auto_review" } }), ["bot.place.filesStay", "bot.place.limits", "bot.place.reviewNote"]);
});

test("how a Bot's computer is: ready, with the engine's version when it says one, or why not", () => {
  assert.deepEqual(placeHealth({ ok: true, value: { ok: true, version: "1.4.0" } }), { status: "ready", version: "1.4.0" });
  assert.deepEqual(placeHealth({ ok: true, value: { ok: true } }), { status: "ready" });
  assert.deepEqual(placeHealth({ ok: true, value: { ok: false, reason: "deyin is not signed in" } }), { status: "notReady", reason: "deyin is not signed in" });
  assert.deepEqual(placeHealth({ ok: true, value: { ok: false } }), { status: "notReady", reason: "" });
  assert.deepEqual(placeHealth({ ok: false, error: "That Bot no longer exists." }), { status: "notReady", reason: "That Bot no longer exists." });
});

/* Routines ------------------------------------------------------------------- */

test("a routine says where it runs by itself, and a routine the app starts says nothing", () => {
  const server: RoutineServerView = { state: "server", hostId: "h1", hostLabel: "Dell" };
  assert.deepEqual(routineServerLine(server), { key: "bot.routines.server.running", vars: { server: "Dell", reason: "" }, tone: "ok" });
  assert.deepEqual(routineServerLine({ state: "blocked", hostId: "h1", hostLabel: "Dell", reason: "custom models" }), { key: "bot.routines.server.blocked", vars: { server: "Dell", reason: "custom models" }, tone: "warn" });
  assert.deepEqual(routineServerLine({ state: "waiting", hostId: "h1", hostLabel: "Dell", reason: "timed out" }), { key: "bot.routines.server.waiting", vars: { server: "Dell", reason: "timed out" }, tone: "warn" });
  assert.equal(routineServerLine(undefined), null);
});

/* Words ------------------------------------------------------------------------ */

test("every word this adds is in all three languages, and the place and server keys differ from each other", () => {
  assert.deepEqual(missingTranslations("zh").filter((key) => key.startsWith("servers.") || key.startsWith("bot.place.") || key.startsWith("bot.routines.server.") || key === "settings.nav.botServers"), []);
  assert.deepEqual(missingTranslations("de").filter((key) => key.startsWith("servers.") || key.startsWith("bot.place.") || key.startsWith("bot.routines.server.") || key === "settings.nav.botServers"), []);
  const keys: MessageKey[] = ["servers.title", "bot.place.title", "bot.routines.server.running"];
  for (const key of keys) assert.notEqual(translate("en", key), key);
});

test("the words that are filled in keep their blanks in every language", () => {
  const blanks: Array<[MessageKey, string[]]> = [
    ["servers.engine.version", ["version"]],
    ["servers.bots", ["count"]],
    ["servers.finished.ok", ["version"]],
    ["servers.finished.failed", ["message"]],
    ["servers.status.running", ["version", "count"]],
    ["servers.remove.title", ["server"]],
    ["servers.purge.title", ["server"]],
    ["servers.forget.title", ["server"]],
    ["bot.place.health.notReady", ["reason"]],
    ["bot.place.health.readyVersion", ["version"]],
    ["bot.routines.server.running", ["server"]],
    ["bot.routines.server.blocked", ["server", "reason"]],
    ["bot.routines.server.waiting", ["server", "reason"]],
  ];
  for (const locale of ["en", "zh", "de"]) {
    for (const [key, names] of blanks) {
      const text = translate(locale, key);
      for (const name of names) assert.ok(text.includes(`{${name}}`), `${locale} ${key} needs {${name}}`);
    }
  }
});
