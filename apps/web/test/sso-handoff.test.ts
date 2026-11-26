import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOKEN_KEY,
  bootstrapSsoSession,
  type KeyValueStore,
  type SsoHandoffEnv,
} from "../src/client/sso-handoff.js";

const APP = "https://chat.openference.com";
const ISSUER = "https://openference.com";
const EXCHANGE_URL = `${ISSUER}/auth/sso/exchange`;
const ME_URL = `${APP}/api/me`;
const NOW = 1_800_000_000_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION = "session_abc.def";

type Event =
  | { type: "replaceUrl"; url: string }
  | { type: "fetch"; url: string; method: string; body: string | null; authorization: string | null }
  | { type: "setItem"; key: string; value: string }
  | { type: "removeItem"; key: string };

interface Harness {
  env: SsoHandoffEnv;
  events: Event[];
  stored: Map<string, string>;
}

type Reply = Response | Error;

/** An app whose address is `href`; `replies` answers each URL the code or session is sent to. */
function harness(href: string, replies: Record<string, Reply>, opts: { issuer?: string; stored?: Record<string, string> } = {}): Harness {
  const events: Event[] = [];
  const stored = new Map(Object.entries(opts.stored ?? {}));
  const storage: KeyValueStore = {
    setItem(key, value) {
      events.push({ type: "setItem", key, value });
      stored.set(key, value);
    },
    removeItem(key) {
      events.push({ type: "removeItem", key });
      stored.delete(key);
    },
  };
  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    events.push({
      type: "fetch",
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      authorization: headers.get("authorization"),
    });
    const reply = replies[url];
    if (!reply) throw new Error(`unexpected request to ${url}`);
    if (reply instanceof Error) throw reply;
    return reply.clone();
  }) as typeof fetch;
  const env: SsoHandoffEnv = {
    href,
    replaceUrl: (url) => events.push({ type: "replaceUrl", url }),
    storage,
    fetch: fakeFetch,
    origin: APP,
    issuer: opts.issuer ?? ISSUER,
    now: () => NOW,
  };
  return { env, events, stored };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetches = (events: Event[]) => events.filter((e) => e.type === "fetch");
const mutations = (events: Event[]) => events.filter((e) => e.type === "setItem" || e.type === "removeItem");

test("a single-use code is taken out of the address, traded over POST, and the session is kept", async () => {
  const h = harness(`${APP}/?sso_code=${"a".repeat(64)}&keep=1#frag`, {
    [EXCHANGE_URL]: json({ session: SESSION, email: "me@example.com", redirect: `${APP}/` }),
    [ME_URL]: json({ email: "me@example.com" }),
  });
  await bootstrapSsoSession(h.env);

  // The code leaves the address before any request goes out.
  assert.deepEqual(h.events[0], { type: "replaceUrl", url: `${APP}/?keep=1#frag` });
  assert.equal(h.events[1]?.type, "fetch");

  const [exchange, me] = fetches(h.events);
  assert.deepEqual(exchange, {
    type: "fetch",
    url: EXCHANGE_URL,
    method: "POST",
    body: JSON.stringify({ code: "a".repeat(64) }),
    authorization: null,
  });
  // The session is proven to this app's own Worker, in a header, never in an address.
  assert.deepEqual(me, { type: "fetch", url: ME_URL, method: "GET", body: null, authorization: `Bearer ${SESSION}` });

  const tokens = JSON.parse(h.stored.get(TOKEN_KEY) ?? "null");
  assert.deepEqual(tokens, {
    accessToken: SESSION,
    tokenType: "Bearer",
    expiresAt: NOW + THIRTY_DAYS_MS,
    scope: "openid profile email model:invoke",
  });
});

test("the session never appears in any address the app asks for", async () => {
  const h = harness(`${APP}/?sso_code=${"b".repeat(64)}`, {
    [EXCHANGE_URL]: json({ session: SESSION, email: "me@example.com" }),
    [ME_URL]: json({ id: 7 }),
  });
  await bootstrapSsoSession(h.env);
  for (const e of h.events) {
    if (e.type === "fetch") assert.ok(!e.url.includes(SESSION), e.url);
    if (e.type === "replaceUrl") assert.ok(!e.url.includes(SESSION), e.url);
  }
});

test("an issuer written with a trailing slash still reaches the exchange route", async () => {
  const h = harness(
    `${APP}/?sso_code=${"c".repeat(64)}`,
    { [EXCHANGE_URL]: json({ session: SESSION }), [ME_URL]: json({ userId: 3 }) },
    { issuer: `${ISSUER}/` }
  );
  await bootstrapSsoSession(h.env);
  assert.equal(fetches(h.events)[0]?.url, EXCHANGE_URL);
  assert.ok(h.stored.has(TOKEN_KEY));
});

test("a code the site refuses leaves an existing sign-in alone", async () => {
  const existing = JSON.stringify({ accessToken: "already-signed-in" });
  for (const status of [400, 429, 500]) {
    const h = harness(
      `${APP}/?sso_code=${"d".repeat(64)}`,
      { [EXCHANGE_URL]: json({ error: "Invalid or expired sign-in." }, status) },
      { stored: { [TOKEN_KEY]: existing } }
    );
    await bootstrapSsoSession(h.env);
    assert.deepEqual(mutations(h.events), [], `status ${status}`);
    assert.equal(h.stored.get(TOKEN_KEY), existing);
    // The code is still out of the address, and nothing was sent to the app's own Worker.
    assert.deepEqual(h.events[0], { type: "replaceUrl", url: `${APP}/` });
    assert.equal(fetches(h.events).length, 1);
  }
});

test("an unreachable site, or an answer without a session, leaves an existing sign-in alone", async () => {
  const existing = JSON.stringify({ accessToken: "already-signed-in" });
  const answers: Reply[] = [new Error("network down"), json({}), json({ session: "" }), json({ session: 42 }), new Response("not json", { status: 200 })];
  for (const answer of answers) {
    const h = harness(`${APP}/?sso_code=${"e".repeat(64)}`, { [EXCHANGE_URL]: answer }, { stored: { [TOKEN_KEY]: existing } });
    await bootstrapSsoSession(h.env);
    assert.deepEqual(mutations(h.events), []);
    assert.equal(h.stored.get(TOKEN_KEY), existing);
  }
});

test("a traded session this app's Worker does not know is not kept, and does not sign anyone out", async () => {
  const existing = JSON.stringify({ accessToken: "already-signed-in" });
  for (const me of [json({ error: "Invalid session" }, 401), json({}), new Error("worker down")]) {
    const h = harness(
      `${APP}/?sso_code=${"f".repeat(64)}`,
      { [EXCHANGE_URL]: json({ session: SESSION }), [ME_URL]: me },
      { stored: { [TOKEN_KEY]: existing } }
    );
    await bootstrapSsoSession(h.env);
    assert.deepEqual(mutations(h.events), []);
    assert.equal(h.stored.get(TOKEN_KEY), existing);
  }
});

test("the legacy ?session= link still signs in, with the session out of the address first", async () => {
  const h = harness(`${APP}/?session=${SESSION}&keep=1`, { [ME_URL]: json({ email: "me@example.com" }) });
  await bootstrapSsoSession(h.env);
  assert.deepEqual(h.events[0], { type: "replaceUrl", url: `${APP}/?keep=1` });
  assert.deepEqual(fetches(h.events).map((e) => e.type === "fetch" && e.url), [ME_URL]);
  assert.equal(JSON.parse(h.stored.get(TOKEN_KEY) ?? "{}").accessToken, SESSION);
});

test("a legacy session that does not validate still clears the stored tokens", async () => {
  const h = harness(
    `${APP}/?session=${SESSION}`,
    { [ME_URL]: json({ error: "Invalid session" }, 401) },
    { stored: { [TOKEN_KEY]: JSON.stringify({ accessToken: "old" }) } }
  );
  await bootstrapSsoSession(h.env);
  assert.deepEqual(mutations(h.events), [{ type: "removeItem", key: TOKEN_KEY }]);
  assert.equal(h.stored.has(TOKEN_KEY), false);
});

test("when both are present the code wins and the legacy session is dropped unused", async () => {
  const other = "legacy_session_value";
  const h = harness(`${APP}/?session=${other}&sso_code=${"1".repeat(64)}`, {
    [EXCHANGE_URL]: json({ session: SESSION }),
    [ME_URL]: json({ email: "me@example.com" }),
  });
  await bootstrapSsoSession(h.env);
  assert.deepEqual(h.events[0], { type: "replaceUrl", url: `${APP}/` });
  assert.equal(JSON.parse(h.stored.get(TOKEN_KEY) ?? "{}").accessToken, SESSION);
  for (const e of h.events) if (e.type === "fetch") assert.notEqual(e.authorization, `Bearer ${other}`);
});

test("an address with no hand-off is left completely alone", async () => {
  for (const href of [`${APP}/`, `${APP}/?x=1`, `${APP}/?sso_code=`, `${APP}/?sso_code=%20%20&session=`]) {
    const h = harness(href, {});
    await bootstrapSsoSession(h.env);
    assert.deepEqual(h.events, [], href);
  }
});
