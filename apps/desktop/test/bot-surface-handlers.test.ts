import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ActivityLog, FileStorage, Outbox, SurfaceStore, plainCipher, type DeyinBot, type HttpFetch, type HubStatus } from "@deyin/host-core";
import { createSurfaceHandlers } from "../src/main/bots/surface-handlers.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function reply(body: unknown, status = 200): Awaited<ReturnType<HttpFetch>> {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "deyin-surface-handlers-"));
  dirs.push(dir);
  const storage = new FileStorage(dir, plainCipher);
  let n = 0;
  const store = new SurfaceStore(storage, { makeKey: () => `key-${(n += 1)}` });
  const outbox = new Outbox(storage);
  const activity = new ActivityLog();
  const calls: Call[] = [];
  let respond: (call: Call) => Awaited<ReturnType<HttpFetch>> = () => reply({ data: { id: "555", text: "x" } }, 201);
  const hubStarts: number[] = [];
  let hubStatus: HubStatus = { listening: true, port: 47_823 };
  const handlers = createSurfaceHandlers({
    bots: { get: (id) => (id === "ada" || id === "grace" ? ({ id } as DeyinBot) : id === "standup" ? ({ id, kind: "room", name: "Standup" } as DeyinBot) : undefined) },
    store,
    outbox,
    activity,
    routines: { get: (id) => (id === "r-ada" ? { id, botId: "ada" } : id === "r-grace" ? { id, botId: "grace" } : id === "r-plain" ? { id } : undefined) },
    hub: {
      status: () => hubStatus,
      start: async (port) => {
        hubStarts.push(port);
        hubStatus = { listening: true, port };
        return hubStatus;
      },
    },
    fetch: async (url, init) => {
      const call: Call = { url, ...(init?.method ? { method: init.method } : {}), ...(init?.headers ? { headers: init.headers } : {}), ...(init?.body ? { body: init.body } : {}) };
      calls.push(call);
      return respond(call);
    },
  });
  return { handlers, store, outbox, activity, calls, hubStarts, respond: (next: typeof respond) => (respond = next), setHub: (status: HubStatus) => (hubStatus = status) };
}

const xForm = (over: Record<string, unknown> = {}) => ({
  routineId: "r-ada",
  enabled: true,
  allow: ["ada"],
  settings: { userId: "99", handle: "deyin_bot" },
  secrets: { accessToken: "x-access-token-1" },
  ...over,
});

function failed<T>(result: { ok: boolean; value?: T; error?: string; code?: string }, code: string, pattern: RegExp): void {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.match(result.error ?? "", pattern);
}

test("the state of a Bot's connections is everything the panel shows, with no secret in it", () => {
  const r = rig();
  r.handlers.save("ada", "x", xForm());
  r.activity.add("ada", "x", "poll-failed", "X answered 401");
  r.outbox.add({ botId: "ada", inReplyTo: "1", context: "c", author: "@a", text: "t" });
  r.outbox.add({ botId: "grace", inReplyTo: "2", context: "c", author: "@a", text: "someone else's draft" });
  const result = r.handlers.state("ada");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.surfaces.length, 1);
  assert.deepEqual(result.value.hub, { settings: { port: 47_823, publicUrl: "" }, status: { listening: true, port: 47_823 } });
  assert.equal(result.value.activity[0]?.detail, "X answered 401");
  assert.deepEqual(result.value.outbox.map((post) => post.botId), ["ada"], "another Bot's drafts are not shown");
  assert.equal(result.value.protection, "file-permissions", "these tests keep secrets with the plain cipher, which is only protected by file permissions");
  assert.equal(JSON.stringify(result).includes("x-access-token-1"), false);
});

test("only a Bot that exists can be asked about, and only its own things come back", () => {
  const r = rig();
  failed(r.handlers.state("nobody"), "not_found", /not here any more/);
  failed(r.handlers.state(7), "invalid", /The Bot is required/);
  failed(r.handlers.state(""), "invalid", /The Bot is required/);
  r.handlers.save("ada", "x", xForm());
  const grace = r.handlers.state("grace");
  assert.equal(grace.ok && grace.value.surfaces.length, 0);
});

test("a room has no connections: it is refused by every call that takes a Bot", () => {
  const r = rig();
  const refusal = /^Standup is a room\. Connect one of its Bots instead\.$/;
  failed(r.handlers.state("standup"), "invalid", refusal);
  failed(r.handlers.save("standup", "x", xForm({ routineId: "" })), "invalid", refusal);
  failed(r.handlers.remake("standup", "webhook", "key"), "invalid", refusal);
  failed(r.handlers.setEnabled("standup", "x", true), "invalid", refusal);
  failed(r.handlers.remove("standup", "x"), "invalid", refusal);
});

test("a surface can be pointed only at a routine that is the Bot's own", () => {
  const r = rig();
  failed(r.handlers.save("ada", "x", xForm({ routineId: "r-grace" })), "invalid", /not one of this Bot's/);
  failed(r.handlers.save("ada", "x", xForm({ routineId: "r-plain" })), "invalid", /not one of this Bot's/);
  failed(r.handlers.save("ada", "x", xForm({ routineId: "nope" })), "invalid", /not one of this Bot's/);
  failed(r.handlers.save("ada", "x", xForm({ routineId: 5 })), "invalid", /chosen from the list/);
  assert.equal(r.handlers.save("ada", "x", xForm()).ok, true);
  assert.equal(r.handlers.save("ada", "x", xForm({ enabled: false, routineId: "" })).ok, true, "none yet is fine while it is off");
});

test("what the store refuses is returned as text, and an unknown place is refused before anything is read", () => {
  const r = rig();
  failed(r.handlers.save("ada", "sms", xForm()), "invalid", /not somewhere a Bot can be reached/);
  failed(r.handlers.save("ada", "x", xForm({ allow: ["not valid!"] })), "invalid", /handles/);
  failed(r.handlers.save("ada", "x", xForm({ secrets: {} })), "invalid", /Still needed: accessToken/);
});

test("a key this app makes comes back once, from saving or making a new one", () => {
  const r = rig();
  const saved = r.handlers.save("ada", "webhook", { routineId: "r-ada", enabled: true });
  assert.equal(saved.ok && saved.value.generated.key, "key-1");
  const again = r.handlers.save("ada", "webhook", { routineId: "r-ada", enabled: true });
  assert.deepEqual(again.ok && again.value.generated, {});
  const made = r.handlers.remake("ada", "webhook", "key");
  assert.equal(made.ok && made.value.value, "key-2");
  failed(r.handlers.remake("ada", "webhook", ""), "invalid", /The key is required/);
  failed(r.handlers.remake("ada", "teams", "key"), "not_found", /Set this surface up first/);
});

test("turning a surface on or off, and taking it away", () => {
  const r = rig();
  r.handlers.save("ada", "webhook", { routineId: "r-ada", enabled: true });
  const off = r.handlers.setEnabled("ada", "webhook", false);
  assert.equal(off.ok && off.value.enabled, false);
  failed(r.handlers.setEnabled("ada", "webhook", "yes"), "invalid", /on or off/);
  failed(r.handlers.setEnabled("ada", "teams", true), "not_found", /not set up/);
  assert.equal(r.handlers.remove("ada", "webhook").ok, true);
  assert.equal(r.store.get("ada", "webhook"), null);
});

test("changing the port listens again on it; changing only the public address does not", async () => {
  const r = rig();
  const moved = await r.handlers.setHub({ port: 5555, publicUrl: "https://bot.example.com" });
  assert.equal(moved.ok && moved.value.settings.port, 5555);
  assert.deepEqual(r.hubStarts, [5555]);
  const same = await r.handlers.setHub({ port: 5555, publicUrl: "https://other.example.com" });
  assert.equal(same.ok && same.value.settings.publicUrl, "https://other.example.com");
  assert.deepEqual(r.hubStarts, [5555], "the same port is not restarted");
  r.setHub({ listening: false, port: 5555, error: "Port 5555 is already in use. Pick another one." });
  const retry = await r.handlers.setHub({ port: 5555, publicUrl: "https://other.example.com" });
  assert.deepEqual(r.hubStarts, [5555, 5555], "a hub that is not listening is started again on save");
  assert.equal(retry.ok, true);
  const bad = await r.handlers.setHub({ port: 80 });
  failed(bad, "invalid", /port must be/);
  assert.equal(r.store.hubSettings().port, 5555);
});

test("the words of a waiting draft can be changed and a draft can be thrown away", () => {
  const r = rig();
  const post = r.outbox.add({ botId: "ada", inReplyTo: "1", context: "c", author: "@a", text: "t" });
  const edited = r.handlers.outboxEdit(post.id, "Better");
  assert.equal(edited.ok && edited.value.text, "Better");
  failed(r.handlers.outboxEdit(post.id, 7), "invalid", /some words/);
  failed(r.handlers.outboxEdit("", "x"), "invalid", /The post is required/);
  const denied = r.handlers.outboxDeny(post.id);
  assert.equal(denied.ok && denied.value.status, "denied");
  failed(r.handlers.outboxDeny(post.id), "conflict", /already been decided/);
});

test("approving posts the words on the card as a reply, once, with the Bot's own token, and records where it went", async () => {
  const r = rig();
  r.handlers.save("ada", "x", xForm());
  const post = r.outbox.add({ botId: "ada", inReplyTo: "1001", context: "c", author: "@a", text: "Thanks for asking!" });
  const done = await r.handlers.outboxApprove(post.id);
  assert.equal(done.ok && done.value.status, "sent");
  assert.equal(done.ok && done.value.url, "https://x.com/i/web/status/555");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]?.url, "https://api.x.com/2/tweets");
  assert.equal(r.calls[0]?.headers?.authorization, "Bearer x-access-token-1");
  assert.deepEqual(JSON.parse(r.calls[0]?.body ?? "{}"), { text: "Thanks for asking!", reply: { in_reply_to_tweet_id: "1001" } });
  failed(await r.handlers.outboxApprove(post.id), "conflict", /already been decided/);
  assert.equal(r.calls.length, 1, "a second approval posts nothing");
});

test("a post X refuses is recorded as failed with X's reason, and is not tried again by itself", async () => {
  const r = rig();
  r.handlers.save("ada", "x", xForm());
  r.respond(() => reply({ title: "Forbidden", detail: "You are not permitted to create a Tweet." }, 403));
  const post = r.outbox.add({ botId: "ada", inReplyTo: "1001", context: "c", author: "@a", text: "Hi" });
  const done = await r.handlers.outboxApprove(post.id);
  assert.equal(done.ok && done.value.status, "failed");
  assert.match((done.ok && done.value.error) || "", /not permitted to create a Tweet/);
  assert.equal(r.calls.length, 1);
});

test("a connection that breaks while posting is recorded as failed without the token, and an answer that is not JSON still ends the draft", async () => {
  const r = rig();
  r.handlers.save("ada", "x", xForm());
  r.respond(() => {
    throw new Error("socket hang up (Bearer x-access-token-1)");
  });
  const one = r.outbox.add({ botId: "ada", inReplyTo: "1001", context: "c", author: "@a", text: "Hi" });
  const first = await r.handlers.outboxApprove(one.id);
  assert.equal(first.ok && first.value.status, "failed");
  assert.doesNotMatch((first.ok && first.value.error) || "", /x-access-token-1/);
  r.respond(() => ({ ok: false, status: 502, json: async () => Promise.reject(new Error("not json")), text: async () => "<html>" }));
  const two = r.outbox.add({ botId: "ada", inReplyTo: "1002", context: "c", author: "@a", text: "Hi" });
  const second = await r.handlers.outboxApprove(two.id);
  assert.equal(second.ok && second.value.status, "failed");
  assert.match((second.ok && second.value.error) || "", /X did not take the post \(502\)/, "the status is what is reported, not a parse error");
});

test("a draft stays waiting, with nothing sent, when X is not connected, is switched off, or the post it answers has a strange id", async () => {
  const r = rig();
  const post = r.outbox.add({ botId: "ada", inReplyTo: "1001", context: "c", author: "@a", text: "Hi" });
  failed(await r.handlers.outboxApprove(post.id), "invalid", /not connected/);
  r.handlers.save("ada", "x", xForm());
  r.handlers.setEnabled("ada", "x", false);
  failed(await r.handlers.outboxApprove(post.id), "invalid", /switched off/);
  r.handlers.setEnabled("ada", "x", true);
  const odd = r.outbox.add({ botId: "ada", inReplyTo: "abc/../def", context: "c", author: "@a", text: "Hi" });
  failed(await r.handlers.outboxApprove(odd.id), "invalid", /id X would not recognise/);
  assert.equal(r.calls.length, 0);
  assert.equal(r.outbox.list("ada").every((p) => p.status === "pending"), true);
  failed(await r.handlers.outboxApprove("missing"), "not_found", /not in the Outbox/);
  failed(await r.handlers.outboxApprove(""), "invalid", /The post is required/);
});

test("a draft stays waiting when the access token can no longer be read", async () => {
  const r = rig();
  r.handlers.save("ada", "x", xForm());
  const post = r.outbox.add({ botId: "ada", inReplyTo: "1001", context: "c", author: "@a", text: "Hi" });
  (r.store as { secret: unknown }).secret = () => null;
  failed(await r.handlers.outboxApprove(post.id), "invalid", /not connected/);
  assert.equal(r.calls.length, 0);
  assert.equal(r.outbox.list("ada")[0]?.status, "pending");
});

test("a draft that is too long cannot be approved until it is shortened, and nothing is sent meanwhile", async () => {
  const r = rig();
  r.handlers.save("ada", "x", xForm());
  const post = r.outbox.add({ botId: "ada", inReplyTo: "1001", context: "c", author: "@a", text: "a".repeat(300) });
  failed(await r.handlers.outboxApprove(post.id), "invalid", /longer than 280/);
  assert.equal(r.calls.length, 0);
  r.handlers.outboxEdit(post.id, "short");
  const done = await r.handlers.outboxApprove(post.id);
  assert.equal(done.ok && done.value.status, "sent");
});
