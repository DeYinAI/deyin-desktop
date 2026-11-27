import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SSO_CODE_PARAM,
  SSO_PENDING_KEY,
  SSO_PENDING_TTL_MS,
  SSO_STATE_PARAM,
  TOKEN_KEY,
  beginSsoSignIn,
  bootstrapSsoSession,
  randomSsoState,
  type BeginSsoEnv,
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
/** The value this browser started its sign-in with. */
const STATE = "Qm9nR3VzU3RhdGVWYWx1ZQ";
const CODE = "a".repeat(64);

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

interface PendingSeed {
  state: string;
  at: number;
}

/** A sign-in this browser started a minute ago. */
const started = (state = STATE, ageMs = 60_000): PendingSeed => ({ state, at: NOW - ageMs });

/** The address the site sends the browser back to: the code, and the value it was given to carry. */
const comeback = (code = CODE, state = STATE, extra = ""): string =>
  `${APP}/?${SSO_STATE_PARAM}=${state}&${SSO_CODE_PARAM}=${code}${extra}`;

/** An app whose address is `href`; `replies` answers each URL the code or session is sent to. */
function harness(
  href: string,
  replies: Record<string, Reply>,
  opts: { issuer?: string; stored?: Record<string, string>; pending?: PendingSeed[] } = {}
): Harness {
  const events: Event[] = [];
  const stored = new Map(Object.entries(opts.stored ?? {}));
  if (opts.pending) stored.set(SSO_PENDING_KEY, JSON.stringify(opts.pending));
  const storage: KeyValueStore = {
    getItem(key) {
      return stored.get(key) ?? null;
    },
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
const pendingStates = (h: Harness): string[] =>
  (JSON.parse(h.stored.get(SSO_PENDING_KEY) ?? "[]") as PendingSeed[]).map((p) => p.state);

test("a code that comes back with the value this browser waits for is traded over POST and the session is kept", async () => {
  const h = harness(
    comeback(CODE, STATE, "&keep=1#frag"),
    {
      [EXCHANGE_URL]: json({ session: SESSION, email: "me@example.com", redirect: `${APP}/` }),
      [ME_URL]: json({ email: "me@example.com" }),
    },
    { pending: [started()] }
  );
  await bootstrapSsoSession(h.env);

  // The code and the value leave the address, and the value is used up, before any request goes out.
  assert.deepEqual(h.events[0], { type: "replaceUrl", url: `${APP}/?keep=1#frag` });
  assert.deepEqual(h.events[1], { type: "removeItem", key: SSO_PENDING_KEY });
  assert.equal(h.events[2]?.type, "fetch");

  const [exchange, me] = fetches(h.events);
  assert.deepEqual(exchange, {
    type: "fetch",
    url: EXCHANGE_URL,
    method: "POST",
    body: JSON.stringify({ code: CODE }),
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
  const h = harness(
    comeback("b".repeat(64)),
    { [EXCHANGE_URL]: json({ session: SESSION, email: "me@example.com" }), [ME_URL]: json({ id: 7 }) },
    { pending: [started()] }
  );
  await bootstrapSsoSession(h.env);
  for (const e of h.events) {
    if (e.type === "fetch") assert.ok(!e.url.includes(SESSION), e.url);
    if (e.type === "replaceUrl") assert.ok(!e.url.includes(SESSION), e.url);
  }
});

test("an issuer written with a trailing slash still reaches the exchange route", async () => {
  const h = harness(
    comeback("c".repeat(64)),
    { [EXCHANGE_URL]: json({ session: SESSION }), [ME_URL]: json({ userId: 3 }) },
    { issuer: `${ISSUER}/`, pending: [started()] }
  );
  await bootstrapSsoSession(h.env);
  assert.equal(fetches(h.events)[0]?.url, EXCHANGE_URL);
  assert.ok(h.stored.has(TOKEN_KEY));
});

// ── Login CSRF: a code somebody else made must not sign this browser in ─────────────────────────

test("a code with no value at all is dropped unopened and signs nobody in", async () => {
  const existing = JSON.stringify({ accessToken: "already-signed-in" });
  // What an attacker sends: a code for their own account, in a link.
  const h = harness(`${APP}/?sso_code=${CODE}`, {}, { stored: { [TOKEN_KEY]: existing }, pending: [started()] });
  await bootstrapSsoSession(h.env);

  assert.deepEqual(fetches(h.events), [], "the code must never reach the site");
  assert.deepEqual(mutations(h.events), [], "nothing is stored or removed");
  assert.equal(h.stored.get(TOKEN_KEY), existing);
  // It still leaves the address, so it cannot be replayed from the history entry.
  assert.deepEqual(h.events[0], { type: "replaceUrl", url: `${APP}/` });
});

test("a code whose value this browser never made is dropped unopened", async () => {
  const h = harness(comeback(CODE, "AttackerChosenValueXX"), {}, { pending: [started()] });
  await bootstrapSsoSession(h.env);
  assert.deepEqual(fetches(h.events), []);
  assert.deepEqual(mutations(h.events), []);
  assert.deepEqual(h.events[0], { type: "replaceUrl", url: `${APP}/` });
});

test("a browser that started no sign-in accepts no code", async () => {
  for (const pending of [undefined, [], [started("short")]]) {
    const h = harness(comeback(), {}, { pending });
    await bootstrapSsoSession(h.env);
    assert.deepEqual(fetches(h.events), []);
    assert.equal(h.stored.has(TOKEN_KEY), false);
  }
});

test("a foreign link does not cancel the sign-in this browser really started", async () => {
  const mine = started();
  const h = harness(comeback(CODE, "AttackerChosenValueXX"), {}, { pending: [mine] });
  await bootstrapSsoSession(h.env);
  assert.deepEqual(pendingStates(h), [STATE]);
  assert.deepEqual(mutations(h.events), []);
});

test("a started sign-in is used up by the code that completes it", async () => {
  const replies = { [EXCHANGE_URL]: json({ session: SESSION }), [ME_URL]: json({ email: "me@example.com" }) };
  const first = harness(comeback(), replies, { pending: [started()] });
  await bootstrapSsoSession(first.env);
  assert.ok(first.stored.has(TOKEN_KEY));
  assert.equal(first.stored.has(SSO_PENDING_KEY), false, "nothing left waiting");

  // The same address again, as a replay from history or a shared link, with what the browser kept.
  const replay = harness(comeback(), replies, { pending: JSON.parse(first.stored.get(SSO_PENDING_KEY) ?? "[]") });
  await bootstrapSsoSession(replay.env);
  assert.deepEqual(fetches(replay.events), []);
  assert.equal(replay.stored.has(TOKEN_KEY), false);
});

test("a sign-in left waiting longer than ten minutes is no longer accepted", async () => {
  const h = harness(comeback(), {}, { pending: [started(STATE, SSO_PENDING_TTL_MS + 1)] });
  await bootstrapSsoSession(h.env);
  assert.deepEqual(fetches(h.events), []);
  assert.equal(h.stored.has(TOKEN_KEY), false);

  const justInTime = harness(
    comeback(),
    { [EXCHANGE_URL]: json({ session: SESSION }), [ME_URL]: json({ email: "me@example.com" }) },
    { pending: [started(STATE, SSO_PENDING_TTL_MS - 1)] }
  );
  await bootstrapSsoSession(justInTime.env);
  assert.ok(justInTime.stored.has(TOKEN_KEY));
});

test("sign-ins started in two tabs both complete, each using up only its own value", async () => {
  const other = "T3RoZXJUYWJWYWx1ZVhY";
  const replies = { [EXCHANGE_URL]: json({ session: SESSION }), [ME_URL]: json({ email: "me@example.com" }) };
  const a = harness(comeback(CODE, STATE), replies, { pending: [started(STATE), started(other)] });
  await bootstrapSsoSession(a.env);
  assert.ok(a.stored.has(TOKEN_KEY));
  assert.deepEqual(pendingStates(a), [other]);
});

test("a stored value that is not a list of sign-ins is ignored, not trusted", async () => {
  for (const junk of ["not json", "{}", "null", JSON.stringify([{ state: STATE }]), JSON.stringify([{ state: 5, at: NOW }]), JSON.stringify([{ state: STATE, at: NOW + 3_600_000 }])]) {
    const h = harness(comeback(), {}, { stored: { [SSO_PENDING_KEY]: junk } });
    await bootstrapSsoSession(h.env);
    assert.deepEqual(fetches(h.events), [], junk);
    assert.equal(h.stored.has(TOKEN_KEY), false, junk);
  }
});

// ── What goes wrong after a code was accepted ───────────────────────────────────────────────────

test("a code the site refuses leaves an existing sign-in alone", async () => {
  const existing = JSON.stringify({ accessToken: "already-signed-in" });
  for (const status of [400, 429, 500]) {
    const h = harness(
      comeback("d".repeat(64)),
      { [EXCHANGE_URL]: json({ error: "Invalid or expired sign-in." }, status) },
      { stored: { [TOKEN_KEY]: existing }, pending: [started()] }
    );
    await bootstrapSsoSession(h.env);
    assert.equal(h.stored.get(TOKEN_KEY), existing, `status ${status}`);
    assert.equal(h.stored.has(SSO_PENDING_KEY), false, "the value was spent");
    // The code is still out of the address, and nothing was sent to the app's own Worker.
    assert.deepEqual(h.events[0], { type: "replaceUrl", url: `${APP}/` });
    assert.equal(fetches(h.events).length, 1);
  }
});

test("an unreachable site, or an answer without a session, leaves an existing sign-in alone", async () => {
  const existing = JSON.stringify({ accessToken: "already-signed-in" });
  const answers: Reply[] = [new Error("network down"), json({}), json({ session: "" }), json({ session: 42 }), new Response("not json", { status: 200 })];
  for (const answer of answers) {
    const h = harness(comeback("e".repeat(64)), { [EXCHANGE_URL]: answer }, { stored: { [TOKEN_KEY]: existing }, pending: [started()] });
    await bootstrapSsoSession(h.env);
    assert.equal(h.stored.get(TOKEN_KEY), existing);
  }
});

test("a traded session this app's Worker does not know is not kept, and does not sign anyone out", async () => {
  const existing = JSON.stringify({ accessToken: "already-signed-in" });
  for (const me of [json({ error: "Invalid session" }, 401), json({}), new Error("worker down")]) {
    const h = harness(
      comeback("f".repeat(64)),
      { [EXCHANGE_URL]: json({ session: SESSION }), [ME_URL]: me },
      { stored: { [TOKEN_KEY]: existing }, pending: [started()] }
    );
    await bootstrapSsoSession(h.env);
    assert.equal(h.stored.get(TOKEN_KEY), existing);
  }
});

// ── The retired ?session= link ──────────────────────────────────────────────────────────────────

test("the retired ?session= link signs nobody in and leaves the address", async () => {
  const existing = JSON.stringify({ accessToken: "already-signed-in" });
  const h = harness(`${APP}/?session=${SESSION}&keep=1`, {}, { stored: { [TOKEN_KEY]: existing }, pending: [started()] });
  await bootstrapSsoSession(h.env);
  assert.deepEqual(h.events[0], { type: "replaceUrl", url: `${APP}/?keep=1` });
  assert.deepEqual(fetches(h.events), [], "the token is never sent anywhere");
  assert.deepEqual(mutations(h.events), [], "and nothing is stored or cleared");
  assert.equal(h.stored.get(TOKEN_KEY), existing);
});

test("when a code and a session both arrive, only the code can sign in, and only with its value", async () => {
  const other = "legacy_session_value";
  const h = harness(
    `${APP}/?session=${other}&sso_state=${STATE}&sso_code=${"1".repeat(64)}`,
    { [EXCHANGE_URL]: json({ session: SESSION }), [ME_URL]: json({ email: "me@example.com" }) },
    { pending: [started()] }
  );
  await bootstrapSsoSession(h.env);
  assert.deepEqual(h.events[0], { type: "replaceUrl", url: `${APP}/` });
  assert.equal(JSON.parse(h.stored.get(TOKEN_KEY) ?? "{}").accessToken, SESSION);
  for (const e of h.events) if (e.type === "fetch") assert.notEqual(e.authorization, `Bearer ${other}`);

  const noValue = harness(`${APP}/?session=${other}&sso_code=${"1".repeat(64)}`, {}, { pending: [started()] });
  await bootstrapSsoSession(noValue.env);
  assert.deepEqual(fetches(noValue.events), []);
  assert.equal(noValue.stored.has(TOKEN_KEY), false);
});

test("an address with no hand-off is left completely alone", async () => {
  for (const href of [`${APP}/`, `${APP}/?x=1`, `${APP}/?sso_code=`, `${APP}/?sso_code=%20%20`, `${APP}/?sso_state=${STATE}`]) {
    const h = harness(href, {}, { pending: [started()] });
    await bootstrapSsoSession(h.env);
    assert.deepEqual(h.events, [], href);
  }
});

// ── Starting a sign-in ──────────────────────────────────────────────────────────────────────────

function beginEnv(storage: KeyValueStore, states: string[], now = NOW, issuer = ISSUER): BeginSsoEnv {
  let i = 0;
  return { origin: APP, issuer, storage, now: () => now, randomState: () => states[i++] ?? "x".repeat(22) };
}

function memoryStorage(initial: Record<string, string> = {}): KeyValueStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

test("starting a sign-in remembers a value and asks the site to bring it back in the return address", () => {
  const storage = memoryStorage();
  const target = new URL(beginSsoSignIn(beginEnv(storage, [STATE])));

  assert.equal(target.origin + target.pathname, `${ISSUER}/auth/sso`);
  const redirect = new URL(target.searchParams.get("redirect") ?? "");
  assert.equal(redirect.origin, APP);
  assert.equal(redirect.pathname, "/");
  assert.equal(redirect.searchParams.get("sso_state"), STATE);

  assert.deepEqual(JSON.parse(storage.map.get(SSO_PENDING_KEY) ?? "null"), [{ state: STATE, at: NOW }]);
});

test("starting a sign-in works with an issuer written with a trailing slash", () => {
  const target = new URL(beginSsoSignIn(beginEnv(memoryStorage(), [STATE], NOW, `${ISSUER}/`)));
  assert.equal(target.origin + target.pathname, `${ISSUER}/auth/sso`);
});

test("each sign-in gets its own value, and an earlier one is kept for a second tab", () => {
  const storage = memoryStorage();
  beginSsoSignIn(beginEnv(storage, [STATE]));
  beginSsoSignIn(beginEnv(storage, ["Second-Value-AAAAAAAA"], NOW + 1_000));
  const kept = (JSON.parse(storage.map.get(SSO_PENDING_KEY) ?? "[]") as PendingSeed[]).map((p) => p.state);
  assert.deepEqual(kept, [STATE, "Second-Value-AAAAAAAA"]);
});

test("starting a sign-in drops the ones that expired and keeps no more than five", () => {
  const storage = memoryStorage({
    [SSO_PENDING_KEY]: JSON.stringify([{ state: "Expired-Value-AAAAAAA", at: NOW - SSO_PENDING_TTL_MS - 5 }]),
  });
  for (let i = 0; i < 7; i++) beginSsoSignIn(beginEnv(storage, [`Value-Number-${i}-AAAAAAAA`], NOW + i));
  const kept = (JSON.parse(storage.map.get(SSO_PENDING_KEY) ?? "[]") as PendingSeed[]).map((p) => p.state);
  assert.equal(kept.length, 5);
  assert.ok(!kept.includes("Expired-Value-AAAAAAA"));
  assert.deepEqual(kept, [2, 3, 4, 5, 6].map((i) => `Value-Number-${i}-AAAAAAAA`));
});

test("the value is 128 random bits in a URL-safe alphabet, new every time", () => {
  const values = new Set(Array.from({ length: 50 }, () => randomSsoState()));
  assert.equal(values.size, 50);
  for (const v of values) assert.match(v, /^[A-Za-z0-9_-]{22}$/);
});

test("a value made for a sign-in round-trips through the address the site builds", async () => {
  // start -> the site adds the code to the return address -> the app accepts it, once.
  const storage = memoryStorage();
  const target = new URL(beginSsoSignIn(beginEnv(storage, [STATE])));
  const back = new URL(target.searchParams.get("redirect") ?? "");
  back.searchParams.set("sso_code", CODE);

  const h = harness(back.toString(), { [EXCHANGE_URL]: json({ session: SESSION }), [ME_URL]: json({ email: "me@example.com" }) });
  h.stored.set(SSO_PENDING_KEY, storage.map.get(SSO_PENDING_KEY) ?? "");
  await bootstrapSsoSession(h.env);
  assert.equal(JSON.parse(h.stored.get(TOKEN_KEY) ?? "{}").accessToken, SESSION);
  assert.equal(h.stored.has(SSO_PENDING_KEY), false);
});
