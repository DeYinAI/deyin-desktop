import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AutomationInfo, BotResult } from "@deyin/contract";
import {
  ACTIVITY_KINDS,
  DEFAULT_HUB_SETTINGS,
  SURFACE_KINDS,
  SURFACE_LIMITS,
  SURFACE_SHAPES,
  missingTranslations,
  translate,
  type ActivityKind,
  type BotSurfacesState,
  type MessageKey,
  type OutboxPost,
  type SurfaceKind,
  type SurfaceView,
} from "@deyin/host-core/shared";
import { ConfirmDialogProvider } from "../src/components/ConfirmDialog.js";
import { BotConnectionsPanel } from "../src/bots/BotConnections.js";
import { initialConnectionsState, type ConnectionsController, type ConnectionsState } from "../src/bots/botConnectionsController.js";
import {
  FIELD_NAMES,
  activityKey,
  activityRows,
  addressFor,
  aboutKey,
  allowHintKey,
  addressLabelKey,
  approveDraft,
  fieldHintKey,
  fieldLabelKey,
  formFromView,
  hubFormFrom,
  hubInput,
  hubProblem,
  inputFromForm,
  isFieldName,
  isHubFormDirty,
  isSurfaceFormDirty,
  kindLabelKey,
  messageRoutineBlock,
  messageRoutineInput,
  missingText,
  noteKey,
  outboxRows,
  parseAllowText,
  routineChoices,
  safeLink,
  statusKey,
  surfaceStatus,
  webhookExample,
  MESSAGE_ROUTINE_PROMPT,
} from "../src/bots/botSurfaces.js";
import { SurfaceActivityList } from "../src/bots/SurfaceActivityList.js";
import { SurfaceCard, type SurfaceCardProps } from "../src/bots/SurfaceCard.js";
import { SurfaceHub } from "../src/bots/SurfaceHub.js";
import { SurfaceOutbox } from "../src/bots/SurfaceOutbox.js";

const noop = () => undefined;
const en = (key: MessageKey): string => translate("en", key);
const ok = <T>(value: T): BotResult<T> => ({ ok: true, value });

function view(kind: SurfaceKind, over: Partial<SurfaceView> = {}): SurfaceView {
  return { botId: "ada", surface: kind, routineId: "r1", enabled: false, allow: [], settings: {}, createdAt: 1, updatedAt: 1, has: {}, missing: [], ...over };
}

function post(over: Partial<OutboxPost> = {}): OutboxPost {
  return { id: "p1", botId: "ada", surface: "x", inReplyTo: "10", context: "What time is it?", author: "@grace", text: "Half past.", status: "pending", createdAt: 1, ...over };
}

function routineInfo(over: Partial<AutomationInfo> = {}): AutomationInfo {
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

/* The words ------------------------------------------------------------------------------ */

test("every connection, outbox and activity string exists in every language", () => {
  for (const locale of ["zh", "de"] as const) {
    const missing = missingTranslations(locale).filter((key) => /^bot\.(conn|outbox|activity)\./.test(key));
    assert.deepEqual(missing, [], `${locale} is missing ${missing.join(", ")}`);
  }
});

test("every surface, field and activity kind maps to a string that exists", () => {
  const exists = (key: MessageKey): void => assert.notEqual(translate("en", key), key, key);
  for (const kind of SURFACE_KINDS) {
    exists(kindLabelKey(kind));
    exists(aboutKey(kind));
    exists(noteKey(kind));
    const allow = allowHintKey(kind);
    if (allow) exists(allow);
    const address = addressLabelKey(kind);
    if (address) exists(address);
    for (const state of ["none", "off", "setup", "on", "blocked"] as const) exists(statusKey(state));
  }
  for (const name of FIELD_NAMES) {
    exists(fieldLabelKey(name));
    const hint = fieldHintKey(name);
    if (hint) exists(hint);
  }
  for (const kind of ACTIVITY_KINDS) exists(activityKey(kind));
  for (const status of ["pending", "posting", "sent", "denied", "failed"] as const) exists(`bot.outbox.status.${status}`);
});

test("every field the host asks for has a name the person can read", () => {
  for (const kind of SURFACE_KINDS) {
    const shape = SURFACE_SHAPES[kind];
    for (const name of [...shape.settings, ...shape.secrets, ...shape.generated]) assert.equal(isFieldName(name), true, `${kind}.${name}`);
  }
  assert.equal(isFieldName("nope"), false);
});

test("what is missing is said in words, and an unknown name is shown as it is", () => {
  assert.equal(missingText(["routine", "allow", "signingSecret", "mystery"], en), "a routine to handle messages, who may reach the Bot, Signing secret, mystery");
  assert.equal(missingText([], en), "");
});

/* Where each surface stands -------------------------------------------------------------- */

test("a surface is not set up, needs setup, is off, is on, or is on but cannot be reached", () => {
  const listening = { listening: true, port: 1 };
  const closed = { listening: false, port: 1 };
  assert.equal(surfaceStatus("webhook", undefined, listening), "none");
  assert.equal(surfaceStatus("webhook", view("webhook", { missing: ["routine"] }), listening), "setup");
  assert.equal(surfaceStatus("webhook", view("webhook", { missing: ["routine"], enabled: true }), listening), "setup");
  assert.equal(surfaceStatus("webhook", view("webhook"), listening), "off");
  assert.equal(surfaceStatus("webhook", view("webhook", { enabled: true }), listening), "on");
  assert.equal(surfaceStatus("webhook", view("webhook", { enabled: true }), closed), "blocked");
  assert.equal(surfaceStatus("slack", view("slack", { enabled: true }), closed), "blocked");
  assert.equal(surfaceStatus("x", view("x", { enabled: true }), closed), "on", "X is asked, not called, so the hub does not matter");
  assert.equal(surfaceStatus("webhook", view("webhook"), closed), "off", "off is off whether or not anything listens");
});

/* A form ---------------------------------------------------------------------------------- */

test("names are read one per line or separated by commas and spaces", () => {
  assert.deepEqual(parseAllowText("a@x.com\n b@x.com ,c@x.com;  d@x.com\n\n"), ["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
  assert.deepEqual(parseAllowText("  \n "), []);
});

test("a new form is empty; an opened one holds what is saved, and never a secret", () => {
  const empty = formFromView("teams", undefined);
  assert.deepEqual(empty, { routineId: "", allow: "", settings: { appId: "", tenantId: "" }, secrets: { appPassword: "" } });
  const saved = formFromView("teams", view("teams", { routineId: "r1", allow: ["u1", "u2"], settings: { appId: "app-1234" }, has: { appPassword: true } }));
  assert.deepEqual(saved, { routineId: "r1", allow: "u1\nu2", settings: { appId: "app-1234", tenantId: "" }, secrets: { appPassword: "" } });
  assert.deepEqual(formFromView("webhook", undefined).secrets, {}, "a made key is not typed in");
});

test("saving sends empty secrets out so they are kept, and empty settings in so they are cleared", () => {
  const form = { routineId: "r1", allow: "u1 u2", settings: { appId: " app-1234 ", tenantId: "" }, secrets: { appPassword: "", other: "  " } };
  assert.deepEqual(inputFromForm(form, true), { routineId: "r1", enabled: true, allow: ["u1", "u2"], settings: { appId: "app-1234", tenantId: "" }, secrets: {} });
  assert.deepEqual(inputFromForm({ ...form, secrets: { appPassword: "new-pass" } }, false).secrets, { appPassword: "new-pass" });
});

test("a form is changed by the routine, the list, a setting or a secret, and not by spacing", () => {
  const saved = view("teams", { routineId: "r1", allow: ["u1"], settings: { appId: "app-1234" }, has: { appPassword: true } });
  const base = formFromView("teams", saved);
  assert.equal(isSurfaceFormDirty("teams", saved, base), false);
  assert.equal(isSurfaceFormDirty("teams", saved, { ...base, allow: "u1  \n" }), false);
  assert.equal(isSurfaceFormDirty("teams", saved, { ...base, routineId: "r2" }), true);
  assert.equal(isSurfaceFormDirty("teams", saved, { ...base, allow: "u1\nu2" }), true);
  assert.equal(isSurfaceFormDirty("teams", saved, { ...base, settings: { ...base.settings, appId: "other-1234" } }), true);
  assert.equal(isSurfaceFormDirty("teams", saved, { ...base, secrets: { appPassword: "x" } }), true);
  assert.equal(isSurfaceFormDirty("teams", undefined, formFromView("teams", undefined)), false);
});

/* Routines ------------------------------------------------------------------------------- */

test("only the Bot's own routines are offered, by name, and one that also runs on a clock is marked", () => {
  const list = [
    routineInfo({ id: "b", name: "zeta" }),
    routineInfo({ id: "a", name: "Alpha", trigger: { kind: "cron", expression: "0 9 * * *" } }),
    routineInfo({ id: "z", name: "Not mine", botId: "grace" }),
    routineInfo({ id: "n", name: "No bot", botId: undefined }),
  ];
  assert.deepEqual(routineChoices(list, "ada"), [
    { id: "a", name: "Alpha", scheduled: true },
    { id: "b", name: "zeta", scheduled: false },
  ]);
});

test("a routine made for messages is manual, has a model, and tells the model where the answer goes", () => {
  const input = messageRoutineInput("ada", "Answer messages", { model: "m", providerId: "p" });
  assert.deepEqual(input.trigger, { kind: "manual" });
  assert.equal(input.botId, "ada");
  assert.equal(input.enabled, true);
  assert.deepEqual(input.payload, { kind: "prompt", prompt: MESSAGE_ROUTINE_PROMPT });
  assert.match(MESSAGE_ROUTINE_PROMPT, /report whose summary is the answer/);
  assert.equal(input.model, "m");
});

test("a routine for messages cannot be made without a model, for an archived Bot, or past the limit", () => {
  const bot = { id: "ada", archived: false };
  assert.equal(messageRoutineBlock([], bot, { model: "m", providerId: "p" }), null);
  assert.equal(messageRoutineBlock([], bot, { model: "", providerId: "" }), "noModel");
  assert.equal(messageRoutineBlock([], { ...bot, archived: true }, { model: "m", providerId: "p" }), "unavailable");
  const full = Array.from({ length: 50 }, (_, index) => routineInfo({ id: `r${index}` }));
  assert.equal(messageRoutineBlock(full, bot, { model: "m", providerId: "p" }), "unavailable");
});

/* This computer -------------------------------------------------------------------------- */

test("address settings are checked as the host checks them, and saved the way the host keeps them", () => {
  assert.equal(hubProblem({ port: "47823", publicUrl: "" }), null);
  assert.match(hubProblem({ port: "80", publicUrl: "" }) ?? "", /1024/);
  assert.match(hubProblem({ port: "abc", publicUrl: "" }) ?? "", /whole number/);
  assert.match(hubProblem({ port: "2e4", publicUrl: "" }) ?? "", /whole number/, "a number written with an exponent is not a port");
  assert.match(hubProblem({ port: "47823.5", publicUrl: "" }) ?? "", /whole number/);
  assert.match(hubProblem({ port: "47823", publicUrl: "http://x.example" }) ?? "", /https/);
  assert.deepEqual(hubInput({ port: " 50000 ", publicUrl: "https://bots.example.com/" }), { port: 50000, publicUrl: "https://bots.example.com" });
});

test("address settings are changed by the port or the address, and not by a trailing slash", () => {
  const saved = { port: 47823, publicUrl: "https://bots.example.com" };
  assert.equal(isHubFormDirty(saved, hubFormFrom(saved)), false);
  assert.equal(isHubFormDirty(saved, { port: "47823", publicUrl: "https://bots.example.com/" }), false);
  assert.equal(isHubFormDirty(saved, { port: "47824", publicUrl: "https://bots.example.com" }), true);
  assert.equal(isHubFormDirty(saved, { port: "47823", publicUrl: "" }), true);
});

test("the address to give a service is local until a public one is set, and X has none", () => {
  const local = addressFor(DEFAULT_HUB_SETTINGS, "slack", "ada");
  assert.deepEqual(local, { url: "http://127.0.0.1:47823/hooks/slack/ada", local: true });
  const open = addressFor({ port: 47823, publicUrl: "https://bots.example.com" }, "slack", "ada");
  assert.deepEqual(open, { url: "https://bots.example.com/hooks/slack/ada", local: false });
  assert.equal(addressFor(DEFAULT_HUB_SETTINGS, "x", "ada"), null);
});

test("the webhook example carries the key where it is known and a stand-in where it is not", () => {
  assert.equal(webhookExample("https://h.example/hooks/webhook/ada", "k-1"), 'curl -X POST -H "X-Deyin-Key: k-1" -d "Hello" "https://h.example/hooks/webhook/ada"');
  assert.match(webhookExample("https://h.example/x", null), /YOUR_KEY/);
});

/* What happened and what waits ------------------------------------------------------------ */

test("what happened is listed newest first with a label for every kind, and failures marked", () => {
  const entries = ACTIVITY_KINDS.map((kind, index) => ({ at: 1000 - index, botId: "ada", surface: "slack" as const, kind, detail: `d${index}` }));
  const rows = activityRows(entries, 100);
  assert.equal(rows.length, ACTIVITY_KINDS.length);
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, "every row has its own key");
  const tone = (kind: ActivityKind) => rows[ACTIVITY_KINDS.indexOf(kind)]?.tone;
  assert.equal(tone("accepted"), "ok");
  assert.equal(tone("replied"), "ok");
  assert.equal(tone("not-allowed"), "warn");
  assert.equal(tone("bad-key"), "warn");
  assert.equal(activityRows(entries, 3).length, 3);
});

test("what waits is oldest first and what was decided is newest first; an edit changes only what waits", () => {
  const posts = [
    post({ id: "old", createdAt: 1 }),
    post({ id: "new", createdAt: 5 }),
    post({ id: "sending", status: "posting", createdAt: 3 }),
    post({ id: "done1", status: "sent", createdAt: 2, decidedAt: 10 }),
    post({ id: "done2", status: "denied", createdAt: 2, decidedAt: 20 }),
  ];
  const { waiting, earlier } = outboxRows(posts, { new: "Edited", done1: "ignored" }, SURFACE_LIMITS.xChars);
  assert.deepEqual(waiting.map((row) => row.post.id), ["old", "sending", "new"]);
  assert.deepEqual(earlier.map((row) => row.post.id), ["done2", "done1"]);
  assert.equal(waiting[2]?.text, "Edited");
  assert.equal(waiting[0]?.over, 0, "a short draft is not over by a negative amount");
  assert.equal(earlier[1]?.text, "Half past.", "a decided post cannot be changed");
  assert.deepEqual(waiting.map((row) => row.open), [true, false, true]);
  assert.equal(outboxRows(posts, {}, SURFACE_LIMITS.xChars, 1).earlier.length, 1);
});

test("a draft is counted the way X counts it: by characters, not bytes, and too long is said how far", () => {
  const { waiting } = outboxRows([post({ id: "a" }), post({ id: "b" }), post({ id: "c" })], { a: "😀".repeat(280), b: "😀".repeat(283), c: "   " }, SURFACE_LIMITS.xChars);
  assert.deepEqual([waiting[0]?.used, waiting[0]?.over, waiting[0]?.problem], [280, 0, null]);
  assert.deepEqual([waiting[1]?.used, waiting[1]?.over, waiting[1]?.problem], [283, 3, "long"]);
  assert.deepEqual([waiting[2]?.used, waiting[2]?.problem], [0, "empty"]);
});

test("only a secure address is shown as a link", () => {
  assert.equal(safeLink("https://x.com/i/web/status/1"), "https://x.com/i/web/status/1");
  assert.equal(safeLink("javascript:alert(1)"), null);
  assert.equal(safeLink("http://x.com/1"), null);
  assert.equal(safeLink("file:///etc/passwd"), null);
  assert.equal(safeLink("not a url"), null);
  assert.equal(safeLink(undefined), null);
});

test("approving a changed draft saves the words first and stops if they are refused; an unchanged one goes straight", async () => {
  const calls: string[] = [];
  const api = {
    outboxEdit: async (_id: string, text: string) => {
      calls.push(`edit:${text}`);
      return ok(post({ text }));
    },
    outboxApprove: async (id: string) => {
      calls.push(`approve:${id}`);
      return ok(post({ status: "sent" }));
    },
  };
  assert.equal((await approveDraft(api, post(), "Half past.")).ok, true);
  assert.deepEqual(calls, ["approve:p1"]);
  calls.length = 0;
  await approveDraft(api, post(), "Nearly six.");
  assert.deepEqual(calls, ["edit:Nearly six.", "approve:p1"]);
  calls.length = 0;
  const refusing = { ...api, outboxEdit: async (): Promise<BotResult<OutboxPost>> => ({ ok: false, code: "invalid", error: "Too long." }) };
  const refused = await approveDraft(refusing, post(), "x");
  assert.deepEqual(refused, { ok: false, error: "Too long." });
  assert.deepEqual(calls, []);
  const thrown = await approveDraft({ ...api, outboxApprove: async () => Promise.reject(new Error("offline")) }, post(), "Half past.");
  assert.deepEqual(thrown, { ok: false, error: "offline" });
});

/* What is drawn --------------------------------------------------------------------------- */

function cardProps(kind: SurfaceKind, over: Partial<SurfaceCardProps> = {}): SurfaceCardProps {
  const saved = over.view;
  return {
    kind,
    botId: "ada",
    view: saved,
    status: surfaceStatus(kind, saved, { listening: true, port: 47823 }),
    hub: DEFAULT_HUB_SETTINGS,
    routines: [{ id: "r1", name: "Answer", scheduled: false }],
    form: null,
    busy: false,
    error: null,
    saved: false,
    generated: {},
    routineMaker: "ok",
    makingRoutine: false,
    onOpen: noop,
    onClose: noop,
    onChange: noop,
    onSave: noop,
    onToggle: noop,
    onRemove: noop,
    onRemake: noop,
    onMakeRoutine: noop,
    onDismissGenerated: noop,
    ...over,
  };
}

function card(kind: SurfaceKind, over: Partial<SurfaceCardProps> = {}): string {
  return renderToStaticMarkup(createElement("ul", null, createElement(SurfaceCard, cardProps(kind, over))));
}

test("a card that is not set up offers to set it up, says what it is for, and shows no form", () => {
  const html = card("slack");
  assert.match(html, />Slack</);
  assert.match(html, /Direct messages and mentions in Slack/);
  assert.match(html, /Not set up/);
  assert.match(html, />Set up</);
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /Turn on/);
});

test("a card that is set up but unfinished says what is still needed and cannot be turned on", () => {
  const html = card("slack", { view: view("slack", { missing: ["allow", "botToken"] }) });
  assert.match(html, /Needs setup/);
  assert.match(html, /Still needed: who may reach the Bot, Bot token\./);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Turn on</);
});

test("a card that is on can be turned off, and one that cannot be reached says so", () => {
  const on = view("webhook", { enabled: true });
  assert.match(card("webhook", { view: on }), />On</);
  assert.match(card("webhook", { view: on }), />Turn off</);
  const blocked = card("webhook", { view: on, status: "blocked" });
  assert.match(blocked, /On, but not reachable/);
});

test("the webhook form shows the address to send to, a command to try, and no list of people", () => {
  const html = card("webhook", { form: formFromView("webhook", undefined) });
  assert.match(html, /http:\/\/127\.0\.0\.1:47823\/hooks\/webhook\/ada/);
  assert.match(html, /Only this computer can reach this address/);
  assert.match(html, /curl -X POST -H &quot;X-Deyin-Key: YOUR_KEY&quot;/);
  assert.doesNotMatch(html, /Who may reach this Bot/);
  assert.match(html, /Anyone who has the key can message this Bot/);
});

test("with a public address set the address is that one and carries no local warning", () => {
  const html = card("webhook", { form: formFromView("webhook", undefined), hub: { port: 47823, publicUrl: "https://bots.example.com" } });
  assert.match(html, /https:\/\/bots\.example\.com\/hooks\/webhook\/ada/);
  assert.doesNotMatch(html, /Only this computer can reach this address/);
});

test("a made key is shown once, with a warning, until the person says they have copied it", () => {
  const html = card("webhook", { view: view("webhook", { has: { key: true } }), generated: { key: "made-key-xyz" } });
  assert.match(html, /made-key-xyz/);
  assert.match(html, /Key: copy it now\. It won&#x27;t be shown again\./);
  assert.match(html, /I&#x27;ve copied it/);
  assert.match(html, />Copy</);
  const after = card("webhook", { view: view("webhook", { has: { key: true } }), generated: {}, form: formFromView("webhook", view("webhook")) });
  assert.doesNotMatch(after, /made-key-xyz/);
  assert.match(after, /Key is set\./);
  assert.match(after, /New Key/);
  assert.doesNotMatch(after, /X-Deyin-Key: made/);
});

test("the example carries the key while it is held, so it can be tried at once", () => {
  const html = card("webhook", { form: formFromView("webhook", view("webhook")), generated: { key: "made-key-xyz" } });
  assert.match(html, /X-Deyin-Key: made-key-xyz/);
});

test("secrets are password fields that are empty even when saved, with a note that they are kept", () => {
  const saved = view("slack", { routineId: "r1", allow: ["U1"], has: { signingSecret: true, botToken: false } });
  const html = card("slack", { view: saved, form: formFromView("slack", saved) });
  const fields = [...html.matchAll(/<input[^>]*type="password"[^>]*>/g)].map((m) => m[0]);
  assert.equal(fields.length, 2);
  for (const field of fields) assert.doesNotMatch(field, /value="[^"]/, "no secret value is drawn");
  assert.match(fields[0] ?? "", /placeholder="Saved\. Leave empty to keep it\."/);
  assert.match(fields[1] ?? "", /placeholder="Paste it here\./);
  assert.match(html, /Signing secret/);
  assert.match(html, /Bot User OAuth Token/);
});

test("a list-based surface asks who may reach it and warns when the list is empty", () => {
  const empty = card("email", { form: formFromView("email", undefined) });
  assert.match(empty, /Who may reach this Bot/);
  assert.match(empty, /Email addresses, one per line\./);
  assert.match(empty, /Nobody can reach this Bot here until you add someone\./);
  assert.match(empty, /From address of an email can be forged/);
  const filled = card("email", { form: { ...formFromView("email", undefined), allow: "ada@example.com" } });
  assert.doesNotMatch(filled, /Nobody can reach this Bot here/);
});

test("X shows no address, says it is asked and not called, and asks for the account", () => {
  const html = card("x", { form: formFromView("x", undefined) });
  assert.doesNotMatch(html, /127\.0\.0\.1/);
  assert.match(html, /once a minute/);
  assert.match(html, /never posted on their own|never posted/);
  assert.match(html, /X user id/);
  assert.match(html, /X handle/);
  assert.match(html, /Access token/);
});

test("Teams marks the tenant as optional and the rest as needed", () => {
  const html = card("teams", { form: formFromView("teams", undefined) });
  assert.match(html, /Optional\. Leave empty to use Microsoft&#x27;s shared tenant\./);
  assert.match(html, /App password/);
  assert.match(html, /Messaging endpoint/);
});

test("the routine choice lists the Bot's routines, marks one on a clock, and can make one, or say why not", () => {
  const props = { form: formFromView("webhook", undefined), routines: [{ id: "r1", name: "Answer", scheduled: false }, { id: "r2", name: "Digest", scheduled: true }] };
  const html = card("webhook", props);
  assert.match(html, />Answer</);
  assert.match(html, />Digest \(also runs on a schedule\)</);
  assert.match(html, /Make a routine for messages/);
  assert.match(card("webhook", { ...props, makingRoutine: true }), /Making…/);
  assert.match(card("webhook", { ...props, routineMaker: "noModel" }), /Choose a model in the app first/);
  assert.doesNotMatch(card("webhook", { ...props, routineMaker: "noModel" }), /Make a routine for messages/);
  assert.doesNotMatch(card("webhook", { ...props, routineMaker: "unavailable" }), /Make a routine for messages|Choose a model/);
  assert.match(card("webhook", { ...props, routines: [] }), /Choose one, or make one for messages/);
});

test("Save waits for a change, shows a refusal, and Disconnect is offered only for a saved surface", () => {
  const fresh = card("webhook", { form: formFromView("webhook", undefined) });
  assert.match(fresh, /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.doesNotMatch(fresh, /Disconnect/);
  const saved = view("webhook", { routineId: "r1" });
  const changed = card("webhook", { view: saved, form: { ...formFromView("webhook", saved), routineId: "" }, error: "Something went wrong." });
  assert.doesNotMatch(changed, /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.match(changed, /Disconnect/);
  assert.match(changed, /role="alert">Something went wrong\./);
  const clean = card("webhook", { view: saved, form: formFromView("webhook", saved), saved: true });
  assert.match(clean, />Saved\.</);
  assert.doesNotMatch(changed.replace(/role="alert">Something went wrong\./, ""), />Saved\.</, "typing after a save no longer says it is saved");
  assert.doesNotMatch(card("webhook", { view: saved, form: { ...formFromView("webhook", saved), routineId: "" }, saved: true }), />Saved\.</);
});

test("a finished surface does not say anything is still needed", () => {
  assert.doesNotMatch(card("webhook", { view: view("webhook") }), /Still needed/);
});

function outbox(over: Partial<Parameters<typeof SurfaceOutbox>[0]> = {}): string {
  const rows = outboxRows([post()], {}, SURFACE_LIMITS.xChars);
  return renderToStaticMarkup(
    createElement(SurfaceOutbox, { waiting: rows.waiting, earlier: rows.earlier, busyId: null, errors: {}, onEdit: noop, onApprove: noop, onDeny: noop, ...over }),
  );
}

test("a draft shows who it answers, what they said, and the words to approve", () => {
  const html = outbox();
  assert.match(html, /Replying to @grace/);
  assert.match(html, /They said: What time is it\?/);
  assert.match(html, />Half past\.</);
  assert.match(html, /10 of 280|\d+ of 280/);
  assert.match(html, /Approve and post/);
  assert.match(html, /Don&#x27;t post/);
});

test("a draft that is too long cannot be approved and says by how much", () => {
  const rows = outboxRows([post({ text: "x".repeat(290) })], {}, SURFACE_LIMITS.xChars);
  const html = outbox({ waiting: rows.waiting });
  assert.match(html, /10 too many characters\./);
  assert.match(html, /class="hint--bad"[^>]*>\d+ of 280 10 too many/);
  assert.doesNotMatch(outbox(), /class="hint--bad"[^>]*>\d+ of 280/, "a draft that fits is not shown as a problem");
  assert.match(html, /<button[^>]*disabled=""[^>]*>Approve and post</);
});

test("a draft being sent cannot be changed or decided, and shows it is posting", () => {
  const rows = outboxRows([post()], {}, SURFACE_LIMITS.xChars);
  const html = outbox({ waiting: rows.waiting, busyId: "p1" });
  assert.match(html, /readonly=""/);
  assert.match(html, /Posting…/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Don&#x27;t post</);
});

test("a refusal about one draft is shown on that draft", () => {
  assert.match(outbox({ errors: { p1: "X is switched off for this Bot." } }), /role="alert">X is switched off for this Bot\./);
});

test("an empty outbox says so, and decided posts show how they ended, with a link only when it is safe", () => {
  assert.match(outbox({ waiting: [] }), /Nothing is waiting\./);
  const rows = outboxRows(
    [
      post({ id: "a", status: "sent", url: "https://x.com/i/web/status/9", decidedAt: 3 }),
      post({ id: "b", status: "failed", error: "X said no.", decidedAt: 2 }),
      post({ id: "c", status: "denied", decidedAt: 1, url: "javascript:alert(1)" }),
    ],
    {},
    SURFACE_LIMITS.xChars,
  );
  const html = outbox({ waiting: [], earlier: rows.earlier });
  assert.match(html, /Posted/);
  assert.match(html, /Couldn&#x27;t post/);
  assert.match(html, /Not posted/);
  assert.match(html, /X said no\./);
  assert.match(html, /href="https:\/\/x\.com\/i\/web\/status\/9"/);
  assert.equal([...html.matchAll(/<a /g)].length, 1);
  assert.doesNotMatch(html, /javascript:/);
});

test("the activity list says what happened, and says so when nothing has", () => {
  const rows = activityRows([{ at: Date.UTC(2026, 0, 5, 12, 0), botId: "ada", surface: "slack", kind: "not-allowed", detail: "U999" }]);
  const html = renderToStaticMarkup(createElement(SurfaceActivityList, { rows }));
  assert.match(html, /Turned away: not on the list/);
  assert.match(html, /Slack/);
  assert.match(html, /U999/);
  assert.doesNotMatch(html, /×/, "a thing that happened once has no count");
  const repeated = activityRows([{ at: 1, botId: "ada", surface: "webhook", kind: "bad-key", detail: "", count: 37 }]);
  assert.equal(repeated[0]?.count, 37);
  assert.match(renderToStaticMarkup(createElement(SurfaceActivityList, { rows: repeated })), /×37/);
  assert.match(renderToStaticMarkup(createElement(SurfaceActivityList, { rows: [] })), /Nothing yet\./);
});

function hub(over: Partial<Parameters<typeof SurfaceHub>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(SurfaceHub, {
      settings: DEFAULT_HUB_SETTINGS,
      status: { listening: true, port: 47823 },
      form: hubFormFrom(DEFAULT_HUB_SETTINGS),
      busy: false,
      error: null,
      saved: false,
      onChange: noop,
      onSave: noop,
      onRetry: noop,
      ...over,
    }),
  );
}

test("this computer says where it listens, or that it does not, or why it cannot, with a way to try again", () => {
  assert.match(hub(), /Listening on port 47823\./);
  assert.match(hub({ status: { listening: false, port: 47823 } }), /Not listening\./);
  const blocked = hub({ status: { listening: false, port: 47823, error: "That port is already in use." } });
  assert.match(blocked, /Can&#x27;t listen on port 47823: That port is already in use\./);
  assert.match(blocked, />Try again</);
  assert.doesNotMatch(hub(), /Try again/);
});

test("the address settings can be saved only when they changed and are valid, and a problem is shown while typing", () => {
  assert.match(hub(), /<button[^>]*type="submit"[^>]*disabled=""/);
  const typing = hub({ form: { port: "47823", publicUrl: "http://nope.example" } });
  assert.match(typing, /must start with https/);
  assert.match(typing, /<button[^>]*type="submit"[^>]*disabled=""/);
  const fine = hub({ form: { port: "50000", publicUrl: "" } });
  assert.doesNotMatch(fine, /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.match(hub({ error: "Refused." }), /role="alert">Refused\./);
  assert.match(hub({ busy: true, form: { port: "50000", publicUrl: "" } }), /Saving…/);
  assert.match(hub({ saved: true }), />Saved\.</);
  assert.doesNotMatch(hub({ saved: true, form: { port: "50000", publicUrl: "" } }), />Saved\.</, "typing after a save no longer says it is saved");
});

function panel(state: Partial<ConnectionsState>, over: Partial<Parameters<typeof BotConnectionsPanel>[0]> = {}): string {
  const controller = new Proxy({}, { get: () => noop }) as unknown as ConnectionsController;
  return renderToStaticMarkup(
    createElement(
      ConfirmDialogProvider,
      null,
      createElement(BotConnectionsPanel, { bot: { id: "ada", archived: false }, state: { ...initialConnectionsState(), ...state }, controller, defaults: { model: "m", providerId: "p" }, ...over }) as ReactElement,
    ),
  );
}

function ready(over: Partial<BotSurfacesState> = {}): ConnectionsState["load"] {
  return {
    status: "ready",
    state: { surfaces: [], hub: { settings: DEFAULT_HUB_SETTINGS, status: { listening: false, port: 47823 } }, activity: [], outbox: [], protection: "encrypted", ...over },
  };
}

test("the section says it is loading, or why it could not load", () => {
  assert.match(panel({}), /Loading connections…/);
  const failed = panel({ load: { status: "error", error: "Not here." } });
  assert.match(failed, /Couldn&#x27;t load the connections\. Not here\./);
  assert.doesNotMatch(failed, /Slack/);
});

test("a loaded section shows all five ways in, this computer, and what happened", () => {
  const html = panel({ load: ready() });
  for (const kind of SURFACE_KINDS) assert.match(html, new RegExp(`data-kind="${kind}"`));
  assert.match(html, /This computer/);
  assert.match(html, /What happened lately/);
  assert.doesNotMatch(html, /Waiting for your approval/, "no X, nothing waiting: no outbox");
});

test("the outbox appears once X is set up, or while anything is waiting", () => {
  assert.match(panel({ load: ready({ surfaces: [view("x", { missing: ["accessToken"] })] }) }), /Waiting for your approval/);
  assert.match(panel({ load: ready({ outbox: [post()] }) }), /Replying to @grace/);
});

test("a key that is saved is never drawn by the section", () => {
  const html = panel({ load: ready({ surfaces: [view("webhook", { has: { key: true } })] }) });
  assert.doesNotMatch(html, /made-key/);
  assert.match(html, />Off</);
});

test("a section on a computer that cannot encrypt says so; one that can does not", () => {
  assert.match(panel({ load: ready({ protection: "file-permissions" }) }), /cannot encrypt saved keys|can&#x27;t encrypt saved keys/);
  assert.doesNotMatch(panel({ load: ready() }), /can&#x27;t encrypt saved keys/);
});

test("a refusal that belongs to the whole section is shown above the cards", () => {
  assert.match(panel({ load: ready(), notice: "Finish setting this up before turning it on." }), /role="alert">Finish setting this up/);
});
