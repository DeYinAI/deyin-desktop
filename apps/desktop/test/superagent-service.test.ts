import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createBuiltinRegistry } from "@deyin/agent-core";
import type { FetchLike, Logger, SuperagentView } from "@deyin/superagent";
import { createSuperagentChatTools } from "../src/main/superagent-chat-tools.js";
import { GithubDeviceFlow, type DeviceAuthorization } from "../src/main/superagent/github-device-flow.js";
import { SuperagentService, type DeviceFlowOutcome } from "../src/main/superagent/service.js";
import { TokenStore, createCipher, type Cipher } from "../src/main/superagent/token-store.js";

const silent: Logger = { info: () => undefined, warn: () => undefined };
const dirs: string[] = [];
const services: SuperagentService[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "superagent-service-"));
  dirs.push(dir);
  return dir;
};
after(async () => {
  await Promise.all(services.map((service) => service.dispose()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Reversible and not plain text, so a test can tell a stored token from an encrypted one. */
const reversing: Cipher = {
  encrypt: (plain) => `rev:${[...plain].reverse().join("")}`,
  decrypt: (stored) => [...stored.slice(4)].reverse().join(""),
};

const response = (status: number, body: unknown) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

/** GitHub as far as setup goes: it knows a few tokens, all for one account, which can push to acme/app. */
function github(accepted: string[]): FetchLike {
  return async (url, init) => {
    const token = /^Bearer (\S+)$/.exec(init?.headers?.Authorization ?? "")?.[1];
    if (!token || !accepted.includes(token)) return response(401, { message: "Bad credentials" });
    const path = new URL(url).pathname;
    if (path === "/user") return response(200, { login: "agent-bot", id: 7 });
    if (path === "/repos/acme/app") return response(200, { permissions: { push: true } });
    return response(404, { message: "Not Found" });
  };
}

function makeService(
  options: {
    accepted?: string[];
    programs?: string[];
    probe?: (command: string) => Promise<boolean>;
    broadcast?: (view: SuperagentView) => void;
    dir?: string;
    fetch?: FetchLike;
    deviceFlow?: GithubDeviceFlow;
  } = {},
) {
  const dir = options.dir ?? tempDir();
  const programs = options.programs ?? ["git", "gh"];
  const service = new SuperagentService({
    dir,
    cipher: reversing,
    runner: {
      defaultModel: () => null,
      route: () => ({ apiBaseUrl: "https://api.example", getToken: async () => "t" }),
      contextLength: () => undefined,
      options: () => ({ maxSteps: 10, thinking: false }),
      builtinTools: () => createBuiltinRegistry(),
    },
    broadcast: options.broadcast ?? (() => undefined),
    fetch: options.fetch ?? github(options.accepted ?? ["ghp_good_token", "ghp_also_good"]),
    ...(options.deviceFlow ? { deviceFlow: options.deviceFlow } : {}),
    logger: silent,
    probe: options.probe ?? (async (command) => programs.includes(command)),
    tickMs: 20,
    saveDebounceMs: 5,
  });
  services.push(service);
  return { service, dir };
}

const ok = <T>(reply: { ok: boolean }): T => {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return (reply as unknown as { value: T }).value;
};
const failure = (reply: { ok: boolean }): string => {
  assert.equal(reply.ok, false);
  return (reply as unknown as { error: string }).error;
};

test("a fresh install is off, empty and not ready, with the setup steps spelled out", async () => {
  const { service } = makeService();
  await service.start();
  const view = ok<SuperagentView>(service.current());
  assert.equal(view.status.enabled, false);
  assert.equal(view.status.ready, false);
  assert.equal(view.settings.eval.mode, "observe");
  assert.deepEqual(view.tickets, []);
  assert.ok(view.status.gaps.some((gap) => /token/i.test(gap)));
  assert.ok(view.status.gaps.some((gap) => /repository/i.test(gap)));
  assert.ok(view.status.gaps.some((gap) => /allow|originate/i.test(gap)));
});

test("a token GitHub accepts is stored encrypted and never appears in a view", async () => {
  const { service, dir } = makeService();
  await service.start();
  const view = ok<SuperagentView>(await service.setToken("  ghp_good_token  "));
  assert.equal(view.status.account?.login, "agent-bot");
  assert.ok(!view.status.gaps.some((gap) => /connect a github token/i.test(gap)));

  const file = readFileSync(join(dir, "token.json"), "utf8");
  assert.ok(!file.includes("ghp_good_token"), "the token is not written in the clear");
  assert.equal(new TokenStore(join(dir, "token.json"), reversing).get(), "ghp_good_token");
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "token.json")).mode & 0o077, 0, "only the user can read it");
  assert.ok(!JSON.stringify(service.current()).includes("ghp_good_token"));
});

test("a token pasted with its header, quotes or line break is stored as the token itself", async () => {
  for (const pasted of ["Bearer ghp_good_token", "Authorization: Bearer ghp_good_token", "token ghp_good_token", '"ghp_good_token"', "'ghp_good_token'\n", "bearer   `ghp_good_token`"]) {
    const { service, dir } = makeService();
    await service.start();
    ok(await service.setToken(pasted));
    assert.equal(new TokenStore(join(dir, "token.json"), reversing).get(), "ghp_good_token", pasted);
  }
});

test("a token GitHub rejects is not kept, and the one in place keeps working", async () => {
  const { service, dir } = makeService();
  await service.start();
  assert.match(failure(await service.setToken("ghp_bad_token")), /rejected the token/);
  assert.equal(existsSync(join(dir, "token.json")), false, "nothing was stored");
  assert.equal(ok<SuperagentView>(service.current()).status.account, null);

  ok(await service.setToken("ghp_good_token"));
  assert.match(failure(await service.setToken("ghp_bad_token")), /rejected the token/);
  const view = ok<SuperagentView>(service.current());
  assert.equal(view.status.account?.login, "agent-bot");
  assert.equal(new TokenStore(join(dir, "token.json"), reversing).get(), "ghp_good_token");

  assert.match(failure(await service.setToken("   ")), /empty/);
});

test("something that is not a token is refused before it is stored or sent anywhere", async () => {
  const { service, dir } = makeService();
  await service.start();
  for (const text of ["short", "has a space inside", "line\nbreak_in_token", "x".repeat(600)]) {
    assert.match(failure(await service.setToken(text)), /does not look like a GitHub token/, text.slice(0, 12));
  }
  assert.equal(existsSync(join(dir, "token.json")), false);
});

test("a start that fails is shown in the setup list instead of being lost, and does not throw", async () => {
  const { service } = makeService({ probe: async () => { throw new Error("no shell here"); } });
  await service.start();
  const status = ok<SuperagentView>(service.current()).status;
  assert.equal(status.ready, false);
  assert.ok(status.gaps.some((gap) => /could not start: no shell here/i.test(gap)), status.gaps.join("|"));
});

test("disconnecting forgets the token, stops the runtime's runs, and the service keeps working after", async () => {
  const { service, dir } = makeService();
  await service.start();
  ok(await service.setToken("ghp_good_token"));
  const view = ok<SuperagentView>(await service.clearToken());
  assert.equal(view.status.account, null);
  assert.ok(view.status.gaps.some((gap) => /token/i.test(gap)));
  assert.equal(existsSync(join(dir, "token.json")), false);

  // Still alive: settings save and a token can be connected again.
  ok(await service.saveSettings({ github: { repository: "acme/app" } }, ok<SuperagentView>(service.current()).settingsRevision));
  assert.equal(ok<SuperagentView>(await service.setToken("ghp_also_good")).status.account?.login, "agent-bot");
});

test("verify says who the token is and whether it can push to the watched repository", async () => {
  const { service } = makeService();
  await service.start();
  assert.match(failure(await service.verify()), /No GitHub token/);
  ok(await service.setToken("ghp_good_token"));
  assert.match(failure(await service.verify()), /Set the repository/);
  ok(await service.saveSettings({ github: { repository: "acme/app" } }, ok<SuperagentView>(service.current()).settingsRevision));
  assert.deepEqual(ok(await service.verify()), { login: "agent-bot", canPush: true, repository: "acme/app" });
  ok(await service.saveSettings({ github: { repository: "acme/missing" } }, ok<SuperagentView>(service.current()).settingsRevision));
  assert.match(failure(await service.verify()), /agent-bot cannot see acme\/missing/);
});

test("settings problems come back as messages, not exceptions", async () => {
  const { service } = makeService();
  await service.start();
  const revision = ok<SuperagentView>(service.current()).settingsRevision;
  assert.match(failure(await service.saveSettings({ github: { repository: "not a repo" } }, revision)), /owner\/name/);
  assert.match(failure(await service.saveSettings({ executor: { blockedCommands: ["git"] } }, revision)), /cannot be blocked/);
  ok(await service.saveSettings({ github: { repository: "acme/app" } }, revision));
  assert.match(failure(await service.saveSettings({ github: { repository: "acme/other" } }, revision)), /changed|revision|stale|meanwhile/i, "an edit based on an old revision is refused");
});

test("what the machine lacks joins the setup gaps", async () => {
  const { service } = makeService({ programs: ["git"] });
  await service.start();
  const view = ok<SuperagentView>(service.current());
  assert.equal(view.status.ready, false);
  assert.ok(view.status.gaps.some((gap) => /GitHub CLI \(gh\)/.test(gap)));
  assert.ok(!view.status.gaps.some((gap) => /install git/i.test(gap)));
});

test("commands on tickets and messages that do not exist answer with a reason", async () => {
  const { service } = makeService();
  await service.start();
  assert.ok(failure(await service.stopTicket("t-404")).length > 0);
  assert.ok(failure(await service.retryTicket("t-404")).length > 0);
  assert.match(failure(await service.requeue("nope")), /Unknown trigger|cannot be sent to assessment again/);
});

test("changes are pushed to the windows, a burst as one", async () => {
  const pushed: SuperagentView[] = [];
  const { service } = makeService({ broadcast: (view) => pushed.push(view) });
  await service.start();
  const revision = () => ok<SuperagentView>(service.current()).settingsRevision;
  ok(await service.saveSettings({ github: { repository: "acme/app" } }, revision()));
  ok(await service.saveSettings({ github: { repository: "acme/app" }, eval: { mode: "off" } }, revision()));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(pushed.length >= 1 && pushed.length <= 2, `pushed ${pushed.length} times`);
  assert.equal(pushed.at(-1)?.settings.eval.mode, "off");
  const before = pushed.length;
  await service.dispose();
  await service.saveSettings({ github: { repository: "acme/app" }, eval: { mode: "auto" } }, ok<SuperagentView>(service.current()).settingsRevision);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(pushed.length, before, "nothing is pushed after dispose");
});

test("settings and tokens survive a restart of the app", async () => {
  const dir = tempDir();
  const first = makeService({ dir }).service;
  await first.start();
  ok(await first.setToken("ghp_good_token"));
  ok(await first.saveSettings({ github: { repository: "acme/app" }, policy: { sources: { github: { allowed: [{ id: "alice" }] } } } }, 0));
  await first.dispose();

  const second = makeService({ dir }).service;
  await second.start();
  const view = ok<SuperagentView>(second.current());
  assert.equal(view.settings.github.repository, "acme/app");
  assert.equal(view.settings.policy.sources.github?.allowed[0]?.id, "alice");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !ok<SuperagentView>(second.current()).status.account) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ok<SuperagentView>(second.current()).status.account?.login, "agent-bot", "the stored token is used without asking again");
});

test("the safeStorage cipher encrypts when it can and says plainly when it cannot", () => {
  let available = true;
  const cipher = createCipher({
    available: () => available,
    encrypt: (plain) => Buffer.from(`E(${plain})`),
    decrypt: (encrypted) => encrypted.toString().slice(2, -1),
  });
  const sealed = cipher.encrypt("secret");
  assert.ok(sealed.startsWith("enc:") && !sealed.includes("secret"));
  assert.equal(cipher.decrypt(sealed), "secret");
  available = false;
  const plain = cipher.encrypt("secret");
  assert.ok(plain.startsWith("plain:"));
  assert.equal(cipher.decrypt(plain), "secret");
  assert.equal(cipher.decrypt(sealed), "secret", "what was sealed stays readable");
  assert.throws(() => cipher.decrypt("junk"), /Unrecognized/);
});

test("a settings save and ticket actions wait for a token change that is in progress", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = github(["ghp_good_token"]);
  const { service } = makeService({
    fetch: async (url, init) => {
      if (new URL(url).pathname === "/user") await held;
      return inner(url, init);
    },
  });
  await service.start();
  const events: string[] = [];
  const revision = ok<SuperagentView>(service.current()).settingsRevision;
  const connecting = service.setToken("ghp_good_token").then(() => events.push("token"));
  const saving = service.saveSettings({ github: { repository: "acme/app" } }, revision).then(() => events.push("save"));
  const stopping = service.stopTicket("t0").then(() => events.push("stop"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(events, [], "nothing runs while the token is being checked");
  release();
  await Promise.all([connecting, saving, stopping]);
  assert.deepEqual(events, ["token", "save", "stop"], "and then in the order they were asked for");
});

// ---- signing the agent account in from chat (GitHub's device flow) ---------------------------------------------------------

const DEVICE_CODE = { device_code: "dc_secretish_999", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };
const DEVICE_TOKEN = "gho_device_token_abcdef";

/** `github()` for the API, plus the two github.com endpoints the device flow talks to, which answer from a script. */
function deviceGithub(accepted: string[], answers: unknown[]): FetchLike {
  const api = github(accepted);
  return async (url, init) => (url.startsWith("https://github.com/login/") ? response(200, answers.shift()) : api(url, init));
}

/** A device flow on a clock that only moves when it sleeps, so a test never really waits. */
function deviceFlowOn(fetch: FetchLike): GithubDeviceFlow {
  let clock = 0;
  return new GithubDeviceFlow({ clientId: "Iv1.test", fetch, now: () => clock, sleep: async (ms) => void (clock += ms), budgetMs: 12_000 });
}

test("signing in from chat stores the token like a pasted one, and neither it nor the device code is ever returned", async () => {
  const fetch = deviceGithub([DEVICE_TOKEN], [DEVICE_CODE, { access_token: DEVICE_TOKEN, token_type: "bearer", scope: "repo" }]);
  const { service, dir } = makeService({ fetch, deviceFlow: deviceFlowOn(fetch) });
  await service.start();
  assert.equal(service.deviceFlowAvailable(), true);

  const begun = ok<DeviceAuthorization>(await service.beginDeviceFlow());
  assert.equal(begun.userCode, "WDJB-MJHT");
  const finished = ok<DeviceFlowOutcome>(await service.finishDeviceFlow());
  assert.equal(finished.pending, false);
  if (finished.pending) return;
  assert.equal(finished.view.status.account?.login, "agent-bot");

  assert.ok(!readFileSync(join(dir, "token.json"), "utf8").includes(DEVICE_TOKEN), "the token is not written in the clear");
  assert.equal(new TokenStore(join(dir, "token.json"), reversing).get(), DEVICE_TOKEN);
  for (const reply of [begun, finished, service.current()]) {
    const text = JSON.stringify(reply);
    assert.ok(!text.includes(DEVICE_TOKEN), "the token never leaves the main process");
    assert.ok(!text.includes("dc_secretish_999"), "nor does the device code");
  }
});

test("a token from the device flow that GitHub then rejects is not kept", async () => {
  const fetch = deviceGithub(["something_else"], [DEVICE_CODE, { access_token: DEVICE_TOKEN, token_type: "bearer" }]);
  const { service, dir } = makeService({ fetch, deviceFlow: deviceFlowOn(fetch) });
  await service.start();
  ok(await service.beginDeviceFlow());
  failure(await service.finishDeviceFlow());
  assert.equal(existsSync(join(dir, "token.json")) ? new TokenStore(join(dir, "token.json"), reversing).get() : undefined, undefined);
  assert.equal(ok<SuperagentView>(service.current()).status.account, null);
});

test("while the person has not approved, finishing answers pending and keeps the request", async () => {
  const pending = { error: "authorization_pending" };
  // Within a 12 second budget and a 5 second interval, one finish polls twice; the token arrives for the next one.
  const fetch = deviceGithub([DEVICE_TOKEN], [DEVICE_CODE, pending, pending, { access_token: DEVICE_TOKEN, token_type: "bearer" }]);
  const { service } = makeService({ fetch, deviceFlow: deviceFlowOn(fetch) });
  await service.start();
  ok(await service.beginDeviceFlow());
  assert.deepEqual(ok<DeviceFlowOutcome>(await service.finishDeviceFlow()), { pending: true });
  const second = ok<DeviceFlowOutcome>(await service.finishDeviceFlow());
  assert.equal(second.pending, false, "the same request carries on once they approve");
});

test("a build without a GitHub OAuth app says so, and leaves pasting a token as the way in", async () => {
  const { service } = makeService();
  await service.start();
  assert.equal(service.deviceFlowAvailable(), false);
  assert.match(failure(await service.beginDeviceFlow()), /not set up in this build/);
  assert.match(failure(await service.finishDeviceFlow()), /No GitHub sign-in is waiting/);
  ok(await service.setToken("ghp_good_token"));
});

test("the chat tools set Superagent up end to end on the real service, and nothing they say contains the token", async () => {
  const fetch = deviceGithub([DEVICE_TOKEN], [DEVICE_CODE, { access_token: DEVICE_TOKEN, token_type: "bearer", scope: "repo" }]);
  const { service, dir } = makeService({ fetch, deviceFlow: deviceFlowOn(fetch) });
  await service.start();
  const tools = Object.fromEntries(createSuperagentChatTools(service).map((tool) => [tool.name, tool]));
  const said: string[] = [];
  const run = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const out = await tools[name]!.execute(args, {} as never);
    said.push(out);
    return out;
  };

  assert.equal((JSON.parse(await run("superagent_status")) as { ready: boolean }).ready, false);
  assert.match(await run("superagent_set_state", { state: "on" }), /^ERROR: Superagent cannot run yet/);
  assert.match(await run("superagent_configure", { repository: "https://github.com/acme/app", allowed_accounts: ["@alice", "Alice", "bob"] }), /^OK: saved\./);
  assert.match(await run("superagent_connect_github", { action: "start" }), /WDJB-MJHT/);
  assert.match(await run("superagent_connect_github", { action: "finish" }), /^OK: connected as @agent-bot\./);
  assert.equal(await run("superagent_verify"), "OK: @agent-bot can push to acme/app.");
  assert.match(await run("superagent_configure", { watch_issues: true, mode: "observe" }), /^OK: saved\./);
  assert.match(await run("superagent_set_state", { state: "on" }), /^OK: Superagent is on\./);

  const view = ok<SuperagentView>(service.current());
  assert.equal(view.settings.github.repository, "acme/app");
  assert.deepEqual(view.settings.policy.sources.github?.allowed.map((entry) => entry.id), ["alice", "bob"]);
  assert.equal(view.settings.github.observeIssues, true);
  assert.deepEqual([view.settings.enabled, view.settings.paused], [true, false]);
  assert.equal(view.status.account?.login, "agent-bot");
  assert.equal(new TokenStore(join(dir, "token.json"), reversing).get(), DEVICE_TOKEN);

  assert.match(await run("superagent_disconnect"), /^OK: the GitHub token was deleted\./);
  assert.equal(ok<SuperagentView>(service.current()).status.account, null);
  for (const line of said) {
    assert.ok(!line.includes(DEVICE_TOKEN), "the token is not in anything the model read");
    assert.ok(!line.includes("dc_secretish_999"), "nor is the device code");
  }
});
