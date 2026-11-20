import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError, type FetchLike } from "@deyin/superagent";
import { GithubDeviceFlow, githubClientId, type DeviceFlowOptions } from "../src/main/superagent/github-device-flow.js";

interface Call {
  url: string;
  form: URLSearchParams;
  headers: Record<string, string>;
  at: number;
}

const CODE = { device_code: "dc_123", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };
const TOKEN = { access_token: "gho_device_token_1234", token_type: "bearer", scope: "repo" };

/**
 * GitHub as a script: each request gets the next answer. The clock only moves when the flow sleeps, so a test sees exactly how long
 * the flow waited, and nothing really waits.
 */
function harness(script: unknown[], options: Partial<DeviceFlowOptions> = {}) {
  let clock = 0;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const answers = [...script];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, form: new URLSearchParams(init?.body ?? ""), headers: init?.headers ?? {}, at: clock });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { status: 200, headers: { get: () => null }, text: async () => (typeof next === "string" ? next : JSON.stringify(next)) };
  };
  const flow = new GithubDeviceFlow({
    clientId: "Iv1.testclient",
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...options,
  });
  return { flow, calls, sleeps, advance: (ms: number) => (clock += ms), clock: () => clock };
}

const refusal = (pattern: RegExp, code?: string) => (error: unknown) =>
  error instanceof UserError && pattern.test(error.message) && (code === undefined || error.code === code);

test("without a client id the flow is unavailable and asks GitHub for nothing", async () => {
  const { flow, calls } = harness([], { clientId: "  " });
  assert.equal(flow.available, false);
  await assert.rejects(flow.begin(), refusal(/not set up/, "setup"));
  assert.equal(calls.length, 0);
});

test("the client id comes from the environment when set, so a fork can use its own app", () => {
  assert.equal(githubClientId({ DEYIN_GITHUB_CLIENT_ID: "  Iv1.fork  " }), "Iv1.fork");
  assert.equal(githubClientId({}), githubClientId({ DEYIN_GITHUB_CLIENT_ID: "" }));
});

test("asking for a code posts the client id and the repo scope as a form, and returns what the person needs", async () => {
  const { flow, calls } = harness([CODE]);
  assert.equal(flow.available, true);
  const authorization = await flow.begin();
  assert.deepEqual(authorization, { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresInSeconds: 900 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://github.com/login/device/code");
  assert.equal(calls[0]!.form.get("client_id"), "Iv1.testclient");
  assert.equal(calls[0]!.form.get("scope"), "repo");
  assert.equal(calls[0]!.headers.Accept, "application/json");
  assert.equal(calls[0]!.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.ok(!JSON.stringify(authorization).includes("dc_123"), "the device code stays inside the flow");
});

test("pending, then slow_down, then approval: it waits the interval GitHub names and returns the token", async () => {
  const { flow, calls, sleeps } = harness([CODE, { error: "authorization_pending" }, { error: "slow_down", interval: 10 }, TOKEN]);
  await flow.begin();
  assert.equal(await flow.finish(), "gho_device_token_1234");
  assert.deepEqual(sleeps, [5000, 5000, 10000]);
  const polls = calls.slice(1);
  assert.equal(polls.length, 3);
  for (const poll of polls) {
    assert.equal(poll.url, "https://github.com/login/oauth/access_token");
    assert.equal(poll.form.get("device_code"), "dc_123");
    assert.equal(poll.form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(poll.form.get("client_id"), "Iv1.testclient");
  }
  // GitHub answers a poll that comes too soon with slow_down; none came sooner than the interval then in force.
  assert.deepEqual(
    polls.map((poll) => poll.at),
    [5000, 10000, 20000],
  );
});

test("slow_down without an interval adds the five seconds GitHub documents", async () => {
  const { flow, sleeps } = harness([CODE, { error: "slow_down" }, TOKEN]);
  await flow.begin();
  assert.equal(await flow.finish(), "gho_device_token_1234");
  assert.deepEqual(sleeps, [5000, 10000]);
});

test("a token without expires_in or a refresh token is accepted: an OAuth app's token does not expire", async () => {
  const { flow } = harness([CODE, { access_token: "gho_plain", token_type: "bearer" }]);
  await flow.begin();
  assert.equal(await flow.finish(), "gho_plain");
});

test("once the token is out the request is spent", async () => {
  const { flow } = harness([CODE, TOKEN]);
  await flow.begin();
  await flow.finish();
  await assert.rejects(flow.finish(), refusal(/No GitHub sign-in is waiting/, "setup"));
});

test("while the person has not approved, finish gives up for now and never polls faster than the interval", async () => {
  const { flow, calls, sleeps } = harness([CODE, ...Array.from({ length: 10 }, () => ({ error: "authorization_pending" }))], { budgetMs: 12_000 });
  await flow.begin();
  assert.equal(await flow.finish(), undefined);
  assert.deepEqual(sleeps, [5000, 5000]);
  // Coming back continues the same request.
  assert.equal(await flow.finish(), undefined);
  const times = calls.slice(1).map((call) => call.at);
  assert.ok(times.length >= 4, `polled ${times.length} times`);
  for (let index = 1; index < times.length; index++) assert.ok(times[index]! - times[index - 1]! >= 5000, `polls at ${times.join(", ")}`);
});

test("a declined sign-in is reported once and ends the request", async () => {
  const { flow } = harness([CODE, { error: "access_denied" }]);
  await flow.begin();
  await assert.rejects(flow.finish(), refusal(/declined/, "invalid"));
  await assert.rejects(flow.finish(), refusal(/No GitHub sign-in is waiting/));
});

test("a code that expired says so, and a new one can be asked for", async () => {
  const { flow } = harness([CODE, { error: "expired_token" }, { ...CODE, device_code: "dc_second" }, TOKEN]);
  await flow.begin();
  await assert.rejects(flow.finish(), refusal(/expired/, "invalid"));
  await flow.begin();
  assert.equal(await flow.finish(), "gho_device_token_1234");
});

test("a code whose next permitted poll falls after its expiry reports expired once the time has passed, not pending forever", async () => {
  const { flow, advance } = harness([{ ...CODE, expires_in: 12 }, { error: "authorization_pending" }, { error: "authorization_pending" }]);
  await flow.begin();
  assert.equal(await flow.finish(), undefined);
  advance(3000);
  await assert.rejects(flow.finish(), refusal(/expired/));
});

test("starting again replaces an earlier request", async () => {
  const { flow, calls } = harness([CODE, { ...CODE, device_code: "dc_second" }, TOKEN]);
  await flow.begin();
  await flow.begin();
  await flow.finish();
  assert.equal(calls.at(-1)!.form.get("device_code"), "dc_second");
});

test("an app without Device Flow enabled sends the person to the dashboard instead", async () => {
  const { flow } = harness([{ error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App." }]);
  await assert.rejects(flow.begin(), refusal(/Device Flow is not enabled.*Paste a token into the dashboard/, "setup"));
});

test("GitHub's other refusals are passed on in its words", async () => {
  const { flow } = harness([CODE, { error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." }]);
  await flow.begin();
  await assert.rejects(flow.finish(), refusal(/GitHub refused the sign-in: The client_id and\/or client_secret passed are incorrect\./));
});

test("an unreachable GitHub and an answer that is not JSON are reported plainly", async () => {
  await assert.rejects(harness([new Error("socket hang up")]).flow.begin(), refusal(/Could not reach GitHub: socket hang up/));
  await assert.rejects(harness(["<html>Bad gateway</html>"]).flow.begin(), refusal(/not understood/));
  await assert.rejects(harness(['["not","an","object"]']).flow.begin(), refusal(/not understood/));
  await assert.rejects(harness([{ nothing: "useful" }]).flow.begin(), refusal(/not understood/));
});

test("no failure message carries the token or the device code", async () => {
  const messages: string[] = [];
  for (const script of [
    [CODE, { error: "access_denied", access_token_hint: TOKEN.access_token }],
    [CODE, { error: "weird", error_description: "nope" }],
    [CODE, "not json, gho_device_token_1234"],
  ]) {
    const { flow } = harness(script);
    await flow.begin();
    try {
      await flow.finish();
    } catch (error) {
      messages.push(error instanceof Error ? error.message : String(error));
    }
  }
  assert.equal(messages.length, 3);
  for (const message of messages) {
    assert.ok(!message.includes("gho_device_token_1234"), message);
    assert.ok(!message.includes("dc_123"), message);
  }
});
