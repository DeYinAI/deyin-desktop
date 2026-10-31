import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createBuiltinRegistry } from "@deyin/agent-core";
import type { FetchLike, Logger, SuperagentView } from "@deyin/superagent";
import { SuperagentService } from "../src/main/superagent/service.js";
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

function makeService(options: { accepted?: string[]; programs?: string[]; broadcast?: (view: SuperagentView) => void; dir?: string } = {}) {
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
    fetch: github(options.accepted ?? ["good", "also-good"]),
    logger: silent,
    probe: async (command) => programs.includes(command),
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
  const view = ok<SuperagentView>(await service.setToken("  good  "));
  assert.equal(view.status.account?.login, "agent-bot");
  assert.ok(!view.status.gaps.some((gap) => /connect a github token/i.test(gap)));

  const file = readFileSync(join(dir, "token.json"), "utf8");
  assert.ok(!file.includes("good"), "the token is not written in the clear");
  assert.equal(new TokenStore(join(dir, "token.json"), reversing).get(), "good");
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "token.json")).mode & 0o077, 0, "only the user can read it");
  assert.ok(!JSON.stringify(service.current()).includes("good"));
});

test("a token GitHub rejects is not kept, and the one in place keeps working", async () => {
  const { service, dir } = makeService();
  await service.start();
  assert.match(failure(await service.setToken("bad")), /rejected the token/);
  assert.equal(existsSync(join(dir, "token.json")), false, "nothing was stored");
  assert.equal(ok<SuperagentView>(service.current()).status.account, null);

  ok(await service.setToken("good"));
  assert.match(failure(await service.setToken("bad")), /rejected the token/);
  const view = ok<SuperagentView>(service.current());
  assert.equal(view.status.account?.login, "agent-bot");
  assert.equal(new TokenStore(join(dir, "token.json"), reversing).get(), "good");

  assert.match(failure(await service.setToken("   ")), /empty/);
});

test("disconnecting forgets the token, stops the runtime's runs, and the service keeps working after", async () => {
  const { service, dir } = makeService();
  await service.start();
  ok(await service.setToken("good"));
  const view = ok<SuperagentView>(await service.clearToken());
  assert.equal(view.status.account, null);
  assert.ok(view.status.gaps.some((gap) => /token/i.test(gap)));
  assert.equal(existsSync(join(dir, "token.json")), false);

  // Still alive: settings save and a token can be connected again.
  ok(await service.saveSettings({ github: { repository: "acme/app" } }, ok<SuperagentView>(service.current()).settingsRevision));
  assert.equal(ok<SuperagentView>(await service.setToken("also-good")).status.account?.login, "agent-bot");
});

test("verify says who the token is and whether it can push to the watched repository", async () => {
  const { service } = makeService();
  await service.start();
  assert.match(failure(await service.verify()), /No GitHub token/);
  ok(await service.setToken("good"));
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
  ok(await first.setToken("good"));
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
