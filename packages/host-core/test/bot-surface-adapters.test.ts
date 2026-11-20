import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import type { HttpFetch } from "../src/bots/surfaces.js";
import { addressOf, parseEmailDelivery, threadSubject } from "../src/bots/surface-email.js";
import { SLACK_MAX_AGE_SECONDS, parseSlackEvent, slackReplyFailure, slackReplyRequest, verifySlackSignature } from "../src/bots/surface-slack.js";
import {
  BOT_FRAMEWORK_ISSUER,
  BOT_FRAMEWORK_OPENID,
  BotFrameworkKeys,
  BotFrameworkTokens,
  parseTeamsActivity,
  teamsReplyActivity,
  teamsReplyUrl,
  teamsTokenBody,
  teamsTokenUrl,
  tokenKeyId,
  verifyBotFrameworkToken,
  type BotFrameworkKey,
  type TeamsTarget,
} from "../src/bots/surface-teams.js";
import { fitPost, isPostId, parseXMentions, readXPostResult, xMentionsRequest, xPostRequest } from "../src/bots/surface-x.js";
import { generateSurfaceKey, headerOf, hmacSha256Hex, presentedKey, safeEqual, verifyBodySignature } from "../src/bots/surface-verify.js";

/* Shared helpers -------------------------------------------------------------------- */

function reply(body: unknown, status = 200): Awaited<ReturnType<HttpFetch>> {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/* verify ---------------------------------------------------------------------------- */

test("secrets are compared without regard to length, and made keys are long, random and header-safe", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
  const a = generateSurfaceKey();
  const b = generateSurfaceKey();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

test("headers are found whatever the case, and the first of many is taken", () => {
  assert.equal(headerOf({ "X-Test": "1" }, "x-test"), "1");
  assert.equal(headerOf({ "x-test": ["a", "b"] }, "X-Test"), "a");
  assert.equal(headerOf({}, "x"), undefined);
});

test("a webhook's key is read from Authorization: Bearer or X-Deyin-Key, and nothing else", () => {
  assert.equal(presentedKey({ authorization: "Bearer abc123" }), "abc123");
  assert.equal(presentedKey({ Authorization: "bearer   abc123  " }), "abc123");
  assert.equal(presentedKey({ "x-deyin-key": " k " }), "k");
  assert.equal(presentedKey({ authorization: "Basic abc" }), undefined);
  assert.equal(presentedKey({ authorization: "Bearer" }), undefined);
  assert.equal(presentedKey({ authorization: "Bearer a b" }), undefined);
  assert.equal(presentedKey({ authorization: "Digest Bearer abc" }), undefined, "the scheme has to be the first word");
  assert.equal(presentedKey({}), undefined);
  assert.equal(presentedKey({ authorization: "Basic abc", "x-deyin-key": "k" }), "k");
});

test("a signed body is accepted only with the exact signature of that body under that secret", () => {
  const body = '{"a":1}';
  const good = `sha256=${hmacSha256Hex("s3cret", body)}`;
  assert.equal(verifyBodySignature("s3cret", body, good), true);
  assert.equal(verifyBodySignature("s3cret", body, good.toUpperCase().replace("SHA256", "sha256")), true, "hex case does not matter");
  assert.equal(verifyBodySignature("other", body, good), false);
  assert.equal(verifyBodySignature("s3cret", `${body} `, good), false);
  assert.equal(verifyBodySignature("s3cret", body, undefined), false);
  assert.equal(verifyBodySignature("s3cret", body, hmacSha256Hex("s3cret", body)), false, "the sha256= prefix is required");
  assert.equal(verifyBodySignature("s3cret", body, "sha256=abc"), false);
  assert.equal(verifyBodySignature("s3cret", Buffer.from(body), good), true);
});

/* Slack ----------------------------------------------------------------------------- */

const SLACK_NOW = 1_700_000_000_000;

function slackSigned(body: string, secret = "signing", timestamp = String(SLACK_NOW / 1000)): { timestamp: string; signature: string } {
  return { timestamp, signature: `v0=${hmacSha256Hex(secret, `v0:${timestamp}:${body}`)}` };
}

test("a Slack request is accepted only when signed by the secret, for this body, and recent", () => {
  const body = '{"type":"event_callback"}';
  const ok = slackSigned(body);
  const check = (over: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) => verifySlackSignature({ secret: "signing", body, nowMs: SLACK_NOW, ...ok, ...over });
  assert.equal(check(), true);
  assert.equal(check({ secret: "other" }), false);
  assert.equal(check({ body: `${body} ` }), false);
  assert.equal(check({ signature: undefined }), false);
  assert.equal(check({ timestamp: undefined }), false);
  assert.equal(check({ secret: "" }), false);
  assert.equal(check({ secret: "", ...slackSigned(body, "") }), false, "a signature made with no secret at all proves nothing");
  assert.equal(check({ signature: ok.signature.replace("v0=", "v1=") }), false);
  assert.equal(check({ timestamp: "abc" }), false);
  assert.equal(check({ nowMs: SLACK_NOW + SLACK_MAX_AGE_SECONDS * 1000 }), true, "exactly at the limit is allowed");
  assert.equal(check({ nowMs: SLACK_NOW + (SLACK_MAX_AGE_SECONDS + 1) * 1000 }), false, "a replay after five minutes is not");
  assert.equal(check({ nowMs: SLACK_NOW - (SLACK_MAX_AGE_SECONDS + 1) * 1000 }), false, "nor is one from the future");
});

const slackDm = {
  type: "event_callback",
  event_id: "Ev0001",
  team_id: "T1",
  event: { type: "message", channel_type: "im", user: "U024BE7LH", channel: "D0123", text: "  What is on today?  ", ts: "1700000000.000100" },
};

test("Slack's URL check is answered with its challenge", () => {
  assert.deepEqual(parseSlackEvent({ type: "url_verification", challenge: "abc" }), { kind: "challenge", challenge: "abc" });
  assert.equal(parseSlackEvent({ type: "url_verification" }).kind, "ignore");
});

test("a direct message becomes a message from that member, one conversation per direct channel", () => {
  const result = parseSlackEvent(slackDm);
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal(result.message.senderId, "U024BE7LH");
  assert.equal(result.message.text, "What is on today?");
  assert.equal(result.message.conversationKey, "D0123:dm");
  assert.equal(result.message.deliveryId, "slack:Ev0001");
  assert.equal(result.channel, "D0123");
  assert.equal(result.direct, true);
});

test("a mention in a channel is a message in that thread, with the mention taken off the front", () => {
  const result = parseSlackEvent({
    type: "event_callback",
    event_id: "Ev2",
    event: { type: "app_mention", user: "U1ABC", channel: "C99", text: "<@U0BOT> , summarise the thread", ts: "1700000001.000200", thread_ts: "1700000000.000100" },
  });
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal(result.message.text, "summarise the thread");
  assert.equal(result.message.conversationKey, "C99:1700000000.000100");
  assert.equal(result.threadTs, "1700000000.000100");
  assert.equal(result.direct, false);
  const first = parseSlackEvent({ type: "event_callback", event: { type: "app_mention", user: "U1ABC", channel: "C99", text: "<@U0BOT> hi", ts: "1700000002.000300" } });
  assert.equal(first.kind === "message" && first.threadTs, "1700000002.000300", "a mention that starts a thread answers under itself");
});

test("a body that is not an event callback is ignored even when it carries something shaped like an event", () => {
  const event = { ...slackDm.event };
  assert.equal(parseSlackEvent({ type: "app_rate_limited", event }).kind, "ignore");
  assert.equal(parseSlackEvent({ event }).kind, "ignore");
  assert.equal(parseSlackEvent({ ...slackDm }).kind, "message");
});

test("everything that is not a person's plain message to the Bot is ignored, so it can never talk to itself", () => {
  const ignored = (event: Record<string, unknown>) => parseSlackEvent({ type: "event_callback", event: { ...slackDm.event, ...event } }).kind;
  assert.equal(ignored({ bot_id: "B1" }), "ignore");
  assert.equal(ignored({ subtype: "message_changed" }), "ignore");
  assert.equal(ignored({ subtype: "bot_message" }), "ignore");
  assert.equal(ignored({ channel_type: "channel" }), "ignore", "a channel message that did not mention the Bot");
  assert.equal(ignored({ type: "reaction_added" }), "ignore");
  assert.equal(ignored({ user: undefined }), "ignore");
  assert.equal(ignored({ text: "   " }), "ignore");
  assert.equal(ignored({ channel: undefined }), "ignore");
  assert.equal(ignored({ ts: undefined }), "ignore");
  assert.equal(parseSlackEvent(null).kind, "ignore");
  assert.equal(parseSlackEvent({ type: "block_actions" }).kind, "ignore");
  assert.equal(parseSlackEvent({ type: "event_callback" }).kind, "ignore");
  assert.equal(ignored({}), "message");
});

test("the reply goes to the channel with the Bot's token, in the thread for a mention and in the conversation for a direct message", () => {
  const inThread = slackReplyRequest("xoxb-1", { channel: "C99", threadTs: "1.2", direct: false }, "Done.");
  assert.equal(inThread.url, "https://slack.com/api/chat.postMessage");
  assert.equal(inThread.init.headers.authorization, "Bearer xoxb-1");
  assert.deepEqual(JSON.parse(inThread.init.body), { channel: "C99", text: "Done.", thread_ts: "1.2" });
  const direct = slackReplyRequest("xoxb-1", { channel: "D1", threadTs: "1.2", direct: true }, "Done.");
  assert.deepEqual(JSON.parse(direct.init.body), { channel: "D1", text: "Done." });
  const long = JSON.parse(slackReplyRequest("t", { channel: "D1", threadTs: "1", direct: true }, "q".repeat(10_000)).init.body) as { text: string };
  assert.ok(long.text.length <= 3_900);
});

test("Slack's refusal comes in a 200 answer, and is reported with its reason", () => {
  assert.equal(slackReplyFailure({ ok: true }), null);
  assert.match(slackReplyFailure({ ok: false, error: "channel_not_found" }) ?? "", /channel_not_found/);
  assert.match(slackReplyFailure({ ok: false }) ?? "", /unknown error/);
  assert.match(slackReplyFailure("<html>") ?? "", /not understood/);
});

/* Teams ----------------------------------------------------------------------------- */

const APP_ID = "11111111-2222-3333-4444-555555555555";
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
const TEAMS_NOW = 1_700_000_000_000;

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = (key: KeyObject, kid: string): BotFrameworkKey => ({ ...(key.export({ format: "jwk" }) as BotFrameworkKey), kid });
const KEYS = [publicJwk(pair.publicKey, "key-1")];

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jwt(over: { header?: Record<string, unknown>; claims?: Record<string, unknown>; privateKey?: KeyObject } = {}): string {
  const header = b64({ alg: "RS256", typ: "JWT", kid: "key-1", ...over.header });
  const claims = b64({ iss: BOT_FRAMEWORK_ISSUER, aud: APP_ID, exp: TEAMS_NOW / 1000 + 3600, nbf: TEAMS_NOW / 1000 - 60, serviceurl: SERVICE_URL, ...over.claims });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), over.privateKey ?? pair.privateKey).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

const expectation = (over: Partial<Parameters<typeof verifyBotFrameworkToken>[1]> = {}) => ({ appId: APP_ID, keys: KEYS, nowMs: TEAMS_NOW, serviceUrl: SERVICE_URL, ...over });

test("a token Microsoft issued for this Bot and this request is accepted", () => {
  assert.deepEqual(verifyBotFrameworkToken(jwt(), expectation()), { ok: true });
  assert.deepEqual(verifyBotFrameworkToken(jwt({ claims: { serviceurl: "HTTPS://smba.trafficmanager.net/emea" } }), expectation()), { ok: true }, "the URL is compared without case or a trailing slash");
});

test("every way a token can be wrong is refused, each for its own reason", () => {
  const reason = (token: string, over: Partial<Parameters<typeof verifyBotFrameworkToken>[1]> = {}): string => {
    const result = verifyBotFrameworkToken(token, expectation(over));
    return result.ok ? "accepted" : result.reason;
  };
  assert.equal(reason("abc"), "not a token");
  assert.equal(reason("a.b."), "not a token");
  assert.equal(reason("a.b.c"), "not a token");
  assert.equal(reason(jwt({ header: { alg: "none" } })), "wrong algorithm");
  assert.equal(reason(jwt({ header: { alg: "HS256" } })), "wrong algorithm");
  assert.equal(reason(jwt({ header: { kid: "other" } })), "unknown key");
  assert.equal(reason(jwt({ header: { kid: undefined } })), "unknown key");
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.equal(reason(jwt({ privateKey: stranger.privateKey })), "bad signature");
  assert.equal(reason(jwt({ claims: { iss: "https://evil.example" } })), "wrong issuer");
  assert.equal(reason(jwt({ claims: { aud: "someone-else" } })), "wrong audience");
  assert.equal(reason(jwt({ claims: { exp: TEAMS_NOW / 1000 - 301 } })), "expired");
  assert.equal(reason(jwt({ claims: { exp: undefined } })), "expired");
  assert.equal(reason(jwt({ claims: { nbf: TEAMS_NOW / 1000 + 301 } })), "not yet valid");
  assert.equal(reason(jwt({ claims: { serviceurl: undefined } })), "service URL does not match");
  assert.equal(reason(jwt(), { serviceUrl: "https://attacker.example/" }), "service URL does not match");
  assert.equal(reason(jwt(), { keys: [] }), "unknown key");
  assert.equal(reason(jwt({ claims: { exp: TEAMS_NOW / 1000 - 299 } })), "accepted", "a little clock skew is allowed");
});

test("a key that is not an RSA key, or has no id, never stands in for the one a token names", () => {
  const reason = (token: string, keys: BotFrameworkKey[]): string => {
    const result = verifyBotFrameworkToken(token, expectation({ keys }));
    return result.ok ? "accepted" : result.reason;
  };
  const real = KEYS[0] as BotFrameworkKey;
  assert.equal(reason(jwt(), [{ ...real, kty: "EC" }]), "unknown key");
  const withoutId = Object.fromEntries(Object.entries(real).filter(([name]) => name !== "kid")) as BotFrameworkKey;
  assert.equal(reason(jwt({ header: { kid: undefined } }), [withoutId]), "unknown key", "no id on either side is not a match");
  assert.equal(reason(jwt(), [withoutId, real]), "accepted");
});

test("a token whose body was changed after signing is refused", () => {
  const [head, , signature] = jwt().split(".") as [string, string, string];
  const forged = `${head}.${b64({ iss: BOT_FRAMEWORK_ISSUER, aud: APP_ID, exp: TEAMS_NOW / 1000 + 9999, serviceurl: SERVICE_URL })}.${signature}`;
  assert.equal(verifyBotFrameworkToken(forged, expectation()).ok, false);
  assert.equal(tokenKeyId(jwt()), "key-1");
  assert.equal(tokenKeyId("garbage"), undefined);
});

test("Microsoft's keys are fetched once and kept, fetched again after a day, and once more when a token names a key not seen", async () => {
  let now = 0;
  const urls: string[] = [];
  let keys: BotFrameworkKey[] = [publicJwk(pair.publicKey, "key-1")];
  const fetchImpl: HttpFetch = async (url) => {
    urls.push(url);
    if (url === BOT_FRAMEWORK_OPENID) return reply({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" });
    return reply({ keys });
  };
  const source = new BotFrameworkKeys(fetchImpl, () => now, 1000, 100);
  assert.equal((await source.keysFor("key-1")).length, 1);
  assert.equal((await source.keysFor("key-1")).length, 1);
  assert.equal(urls.length, 2, "one look-up of the address and one of the keys");
  now = 50;
  await source.keysFor("rotated");
  assert.equal(urls.length, 2, "not again so soon, even for a key it has not seen");
  now = 200;
  keys = [publicJwk(pair.publicKey, "key-1"), publicJwk(pair.publicKey, "rotated")];
  assert.equal((await source.keysFor("rotated")).length, 2, "a new key is picked up once the cooldown is over");
  assert.equal(urls.length, 4);
  now = 5000;
  await source.keysFor("key-1");
  assert.equal(urls.length, 6, "a day (here a second) later it looks again");
});

test("keys that cannot be fetched or read are errors, never an empty list that would refuse everyone silently", async () => {
  const failing = new BotFrameworkKeys(async () => reply({}, 500));
  await assert.rejects(failing.keysFor(undefined), /could not be found/);
  const noUri = new BotFrameworkKeys(async () => reply({}));
  await assert.rejects(noUri.keysFor(undefined), /not where it said/);
  const insecure = new BotFrameworkKeys(async () => reply({ jwks_uri: "http://login.botframework.com/keys" }));
  await assert.rejects(insecure.keysFor(undefined), /not where it said/);
  const noKeys = new BotFrameworkKeys(async (url) => (url === BOT_FRAMEWORK_OPENID ? reply({ jwks_uri: "https://x.example/k" }) : reply({ nope: 1 })));
  await assert.rejects(noKeys.keysFor(undefined), /not in the form/);
  const keysFail = new BotFrameworkKeys(async (url) => (url === BOT_FRAMEWORK_OPENID ? reply({ jwks_uri: "https://x.example/k" }) : reply({}, 503)));
  await assert.rejects(keysFail.keysFor(undefined), /could not be read/);
});

const teamsMessage = {
  type: "message",
  id: "1700000000000",
  serviceUrl: SERVICE_URL,
  channelId: "msteams",
  from: { id: "29:abc", name: "Ada Lovelace", aadObjectId: "aad-guid-1" },
  recipient: { id: "28:bot", name: "Deyin Bot" },
  conversation: { id: "a:1conversation", conversationType: "personal" },
  text: "<at>Deyin Bot</at>  What  is on today?",
};

test("a Teams message becomes a message from that person, with the mention and extra spaces taken out", () => {
  const result = parseTeamsActivity(teamsMessage);
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal(result.message.text, "What is on today?");
  assert.equal(result.message.senderId, "aad-guid-1");
  assert.deepEqual(result.message.senderAliases, ["aad-guid-1", "29:abc"]);
  assert.equal(result.message.senderLabel, "Ada Lovelace (Teams)");
  assert.equal(result.message.conversationKey, "a:1conversation");
  assert.equal(result.message.deliveryId, "teams:a:1conversation:1700000000000");
  assert.deepEqual(result.target, { serviceUrl: SERVICE_URL, conversationId: "a:1conversation", activityId: "1700000000000", user: { id: "29:abc", name: "Ada Lovelace" }, bot: { id: "28:bot", name: "Deyin Bot" } });
});

test("a person with no directory id is known by their Teams id", () => {
  const result = parseTeamsActivity({ ...teamsMessage, from: { id: "29:abc" } });
  assert.equal(result.kind === "message" && result.message.senderId, "29:abc");
  assert.equal(result.kind === "message" && result.message.senderLabel, "Teams user 29:abc");
});

test("what is not a plain message with an address is ignored", () => {
  for (const patch of [{ type: "typing" }, { type: "conversationUpdate" }, { text: "<at>Bot</at>" }, { serviceUrl: "http://insecure.example/" }, { serviceUrl: undefined }, { id: undefined }, { from: undefined }, { conversation: undefined }, { recipient: undefined }]) {
    assert.equal(parseTeamsActivity({ ...teamsMessage, ...patch }).kind, "ignore", JSON.stringify(patch));
  }
  assert.equal(parseTeamsActivity("nope").kind, "ignore");
});

test("the reply is addressed back to the person in the same conversation, under the service URL the signed request named", () => {
  const parsed = parseTeamsActivity(teamsMessage);
  assert.equal(parsed.kind, "message");
  if (parsed.kind !== "message") return;
  const target: TeamsTarget = parsed.target;
  assert.equal(teamsReplyUrl(target), "https://smba.trafficmanager.net/emea/v3/conversations/a%3A1conversation/activities/1700000000000");
  const activity = teamsReplyActivity(target, "Done.");
  assert.deepEqual(activity, { type: "message", text: "Done.", from: target.bot, recipient: target.user, conversation: { id: "a:1conversation" }, replyToId: "1700000000000" });
});

test("the Bot's own token is asked for from the right tenant, with the app's id and password", () => {
  assert.equal(teamsTokenUrl(undefined), "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token");
  assert.equal(teamsTokenUrl(""), "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token");
  assert.equal(teamsTokenUrl("contoso.onmicrosoft.com"), "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token");
  assert.equal(teamsTokenUrl("a/../b"), "https://login.microsoftonline.com/a%2F..%2Fb/oauth2/v2.0/token", "a tenant cannot change the path");
  const params = new URLSearchParams(teamsTokenBody(APP_ID, "p&ss=word"));
  assert.equal(params.get("grant_type"), "client_credentials");
  assert.equal(params.get("client_id"), APP_ID);
  assert.equal(params.get("client_secret"), "p&ss=word");
  assert.equal(params.get("scope"), "https://api.botframework.com/.default");
});

test("tokens are kept until a minute before they run out, kept apart by app and tenant, and a refusal is explained", async () => {
  let now = 0;
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl: HttpFetch = async (url, init) => {
    calls.push({ url, body: init?.body });
    return reply({ access_token: `tok-${calls.length}`, expires_in: 3600 });
  };
  const tokens = new BotFrameworkTokens(fetchImpl, () => now);
  assert.equal(await tokens.get({ appId: "a", appPassword: "p" }), "tok-1");
  assert.equal(await tokens.get({ appId: "a", appPassword: "p" }), "tok-1");
  assert.equal(await tokens.get({ appId: "a", appPassword: "p", tenant: "t" }), "tok-2");
  now = 3_539_000;
  assert.equal(await tokens.get({ appId: "a", appPassword: "p" }), "tok-1");
  now = 3_541_000;
  assert.equal(await tokens.get({ appId: "a", appPassword: "p" }), "tok-3", "a fresh one is asked for once the old one is within a minute of running out");
  let later = 0;
  let asked = 0;
  const unsaid = new BotFrameworkTokens(async () => reply({ access_token: `t${(asked += 1)}` }), () => later);
  assert.equal(await unsaid.get({ appId: "a", appPassword: "p" }), "t1");
  later = 239_000;
  assert.equal(await unsaid.get({ appId: "a", appPassword: "p" }), "t1", "with no lifetime given, five minutes less one is assumed");
  later = 241_000;
  assert.equal(await unsaid.get({ appId: "a", appPassword: "p" }), "t2");
  await assert.rejects(new BotFrameworkTokens(async () => reply({}, 401)).get({ appId: "a", appPassword: "p" }), /would not give this Bot a token \(401\)/);
  await assert.rejects(new BotFrameworkTokens(async () => reply({})).get({ appId: "a", appPassword: "p" }), /no token/);
});

/* Email ----------------------------------------------------------------------------- */

test("an address is taken out of a display name, lower-cased, or refused", () => {
  assert.equal(addressOf("Ada <Ada@Example.com>"), "ada@example.com");
  assert.equal(addressOf(" ada@example.com "), "ada@example.com");
  assert.equal(addressOf("not an address"), null);
  assert.equal(addressOf("a@b"), null);
  assert.equal(addressOf(""), null);
});

test("replies and forwards of one subject are one thread", () => {
  assert.equal(threadSubject("Re: Re: FWD: Weekly Report "), "weekly report");
  assert.equal(threadSubject("Weekly report"), "weekly report");
  assert.equal(threadSubject("AW: Bericht"), "bericht");
  assert.equal(threadSubject("Resume"), "resume", "a word that merely starts with re is not a prefix");
  assert.equal(threadSubject("a".repeat(300)).length, 200, "a very long subject is cut");
});

test("a plain email becomes a message from its sender with the subject in front, one conversation per thread", () => {
  const result = parseEmailDelivery({ from: "Ada <Ada@Example.com>", subject: "Re: Report", text: " Please send it. ", messageId: "m1" });
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal(result.message.senderId, "ada@example.com");
  assert.equal(result.message.text, "Subject: Re: Report\n\nPlease send it.");
  assert.equal(result.message.conversationKey, "ada@example.com:report");
  assert.equal(result.message.deliveryId, "email:m1");
});

test("a Postmark inbound email is read with its sender's name and only the new text of a reply", () => {
  const result = parseEmailDelivery({
    FromFull: { Email: "Ada@Example.com", Name: "Ada Lovelace" },
    From: "ignored@example.com",
    Subject: "Hello",
    TextBody: "Hi\n\n> quoted history",
    StrippedTextReply: "Hi",
    MessageID: "pm-1",
  });
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal(result.message.senderId, "ada@example.com");
  assert.equal(result.message.senderLabel, "Ada Lovelace <ada@example.com>");
  assert.equal(result.message.text, "Subject: Hello\n\nHi");
  assert.equal(result.message.deliveryId, "email:pm-1");
});

test("when a mail carries both the whole text and only the new part, the new part is what the Bot is given", () => {
  const result = parseEmailDelivery({ from: "ada@example.com", subject: "Hi", text: "Whole thing with the quoted history", StrippedTextReply: "Only the new words" });
  assert.equal(result.kind === "message" ? result.message.text : "", "Subject: Hi\n\nOnly the new words");
});

test("mail with no usable sender or no words is ignored", () => {
  assert.equal(parseEmailDelivery({ subject: "x", text: "y" }).kind, "ignore");
  assert.equal(parseEmailDelivery({ from: "nobody", subject: "x", text: "y" }).kind, "ignore");
  assert.equal(parseEmailDelivery({ from: "a@example.com" }).kind, "ignore");
  assert.equal(parseEmailDelivery(null).kind, "ignore");
  assert.equal(parseEmailDelivery({ from: "a@example.com", text: "just a body" }).kind === "message" && true, true);
  const noSubject = parseEmailDelivery({ from: "a@example.com", text: "just a body" });
  assert.equal(noSubject.kind === "message" && noSubject.message.text, "just a body");
});

/* X --------------------------------------------------------------------------------- */

const mentions = {
  data: [
    { id: "1002", text: "@deyin_bot  second question", author_id: "7", conversation_id: "1000" },
    { id: "1001", text: "@deyin_bot @someone first question", author_id: "7", conversation_id: "1000" },
    { id: "1003", text: "@deyin_bot (the Bot's own words)", author_id: "99" },
    { id: "1004", text: "@deyin_bot", author_id: "8" },
  ],
  includes: { users: [{ id: "7", username: "Ada_Lovelace" }] },
  meta: { newest_id: "1004", result_count: 4 },
};

test("the mentions request asks for what is new since the last one, with the author's name, and nothing odd gets into it", () => {
  const first = xMentionsRequest("tok", "99");
  assert.match(first.url, /^https:\/\/api\.x\.com\/2\/users\/99\/mentions\?/);
  assert.ok(!first.url.includes("since_id"));
  assert.equal(first.init.headers.authorization, "Bearer tok");
  assert.match(xMentionsRequest("tok", "99", "1004").url, /since_id=1004/);
  assert.ok(!xMentionsRequest("tok", "99", "1004&evil=1").url.includes("evil"));
  assert.match(first.url, /expansions=author_id/);
  assert.equal(new URL(first.url).searchParams.get("max_results"), "100", "as many as X gives in one go");
  assert.match(xMentionsRequest("tok", "9/../9").url, /\/users\/9%2F\.\.%2F9\/mentions/, "an id cannot change the path");
});

test("mentions come oldest first with the leading handles removed, and the Bot's own and empty posts are skipped", () => {
  const result = parseXMentions(mentions, "99");
  assert.deepEqual(result.mentions.map((m) => m.tweetId), ["1001", "1002"]);
  assert.equal(result.mentions[0]?.message.text, "first question");
  assert.equal(result.mentions[0]?.message.senderId, "ada_lovelace");
  assert.deepEqual(result.mentions[0]?.message.senderAliases, ["ada_lovelace", "7"]);
  assert.equal(result.mentions[0]?.author, "@ada_lovelace");
  assert.equal(result.mentions[0]?.message.conversationKey, "1000");
  assert.equal(result.mentions[0]?.message.deliveryId, "x:1001");
  assert.equal(result.newestId, "1004");
});

test("an author whose name is not known is identified by id, and an empty answer has no mentions", () => {
  const result = parseXMentions({ data: [{ id: "5", text: "@bot hi", author_id: "42" }] }, "99");
  assert.equal(result.mentions[0]?.message.senderId, "42");
  assert.equal(result.mentions[0]?.author, "42");
  assert.equal(result.mentions[0]?.message.conversationKey, "5");
  assert.deepEqual(parseXMentions({ meta: { result_count: 0 } }, "99"), { mentions: [] });
  assert.deepEqual(parseXMentions(null, "99"), { mentions: [] });
  assert.deepEqual(parseXMentions({ data: [{ id: "x1", text: "@a b", author_id: "1" }] }, "99").mentions, [], "an id that is not a number is dropped");
  const mixed = parseXMentions({ data: [{ id: "9", text: "@a two", author_id: "1" }, { id: "x1", text: "@a bad", author_id: "1" }, { id: "10", text: "@a three", author_id: "1" }] }, "99");
  assert.deepEqual(mixed.mentions.map((m) => m.tweetId), ["9", "10"], "numbers are ordered as numbers, and a bad id does not stop the others");
});

test("a post is a reply to one post, with only the words that were approved", () => {
  const request = xPostRequest("tok", "Thanks!", "1001");
  assert.equal(request.url, "https://api.x.com/2/tweets");
  assert.equal(request.init.headers.authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(request.init.body), { text: "Thanks!", reply: { in_reply_to_tweet_id: "1001" } });
});

test("X's answer to a post is read for where it went or why it did not", () => {
  assert.deepEqual(readXPostResult(201, { data: { id: "55", text: "x" } }), { ok: true, id: "55", url: "https://x.com/i/web/status/55" });
  const refused = readXPostResult(403, { title: "Forbidden", detail: "You are not permitted to create a Tweet." });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /not permitted to create a Tweet/);
  assert.match(readXPostResult(401, {}).ok ? "" : (readXPostResult(401, {}) as { error: string }).error, /access token/);
  assert.match((readXPostResult(429, {}) as { error: string }).error, /too many posts/);
  assert.match((readXPostResult(500, { errors: [{ message: "boom" }] }) as { error: string }).error, /boom/);
  assert.equal(readXPostResult(200, {}).ok, false, "a success status with no post id is not a success");
  assert.equal(readXPostResult(500, { data: { id: "56" } }).ok, false, "an error status is not a success whatever else it carries");
  assert.match((readXPostResult(403, {}) as { error: string }).error, /would not allow the post \(403\)/, "403 is a refusal of permission, not a plain failure");
  assert.doesNotMatch((readXPostResult(500, {}) as { error: string }).error, /would not allow/);
});

test("post ids are numbers, and a reply is cut at 280 characters with an ellipsis, never in the middle of a character", () => {
  assert.equal(isPostId("12345"), true);
  assert.equal(isPostId("12a"), false);
  assert.equal(isPostId(""), false);
  assert.equal(fitPost("short"), "short");
  assert.equal(fitPost("a".repeat(280)), "a".repeat(280), "exactly the limit is left alone");
  assert.equal([...fitPost("a".repeat(281))].length, 280);
  const cut = fitPost("a".repeat(400));
  assert.equal([...cut].length, 280);
  assert.ok(cut.endsWith("…"));
  const emoji = fitPost("😀".repeat(400));
  assert.equal([...emoji].length, 280);
  assert.ok(!emoji.includes("\ufffd"));
});
