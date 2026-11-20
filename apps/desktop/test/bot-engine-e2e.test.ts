import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { EngineRegistryStore, FileStorage, SshHostsStore, plainCipher, type EngineSetupEvent } from "@deyin/host-core";
import { connectSsh } from "../src/main/automations/ssh-client.js";
import { EngineClient } from "../src/main/bots/engine/client.js";
import { installEngine, uninstallEngine } from "../src/main/bots/engine/installer.js";
import { BotEngineService } from "../src/main/bots/engine/service.js";
import { FakeServer, freePort } from "./helpers/fake-server.js";
import { makeBot } from "./helpers/bots.js";
import { startSshServer } from "./helpers/ssh-server.js";

/**
 * The whole chain on one machine and nothing faked in between: a saved server (with its host key pinned) in the app's
 * own store, a real SSH connection to it, the installer's real scripts run there in a real shell, the real engine
 * started behind a pretend `deyin`, and a Bot's runtime reaching it through an SSH forward. What stays pretend is
 * only the server's operating system and the agent's model.
 */

const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function setup() {
  const fake = new FakeServer();
  const ssh = await startSshServer({ env: fake.env, cwd: fake.home });
  const dir = mkdtempSync(join(tmpdir(), "deyin-e2e-"));
  const storage = new FileStorage(dir, plainCipher);
  const hosts = new SshHostsStore(storage);
  const saved = hosts.add({ label: "Dell", host: "127.0.0.1", port: ssh.port, username: ssh.username, authMethod: "password" });
  hosts.setCredentials(saved.id, { password: ssh.password });
  hosts.setKnownFingerprint(saved.id, ssh.fingerprint);
  const registry = new EngineRegistryStore(storage);
  const events: EngineSetupEvent[] = [];
  const port = await freePort();
  const filesDir = join(dir, "bot-files");
  const service = new BotEngineService({
    registry,
    hosts: { list: () => hosts.list() },
    bots: { list: () => [] },
    connect: async (hostId) => (await connectSsh({ hostId, hosts })).client,
    filesDir: (botId) => join(filesDir, botId),
    emit: (event) => events.push(event),
    // The same installer, told to use a free port rather than the one a real server would.
    installer: {
      install: (options) => installEngine({ ...options, port, verifyAttempts: 80, verifyIntervalMs: 100 }),
      uninstall: uninstallEngine,
    },
  });
  cleanups.push(async () => {
    service.dispose();
    await ssh.close();
    await storage.flush();
    fake.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  return { fake, ssh, hosts, hostId: saved.id, registry, service, events, port };
}

test("a server saved in the app gets an engine, and a Bot on it works through the SSH link", async () => {
  const t = await setup();

  const installed = await t.service.install(t.hostId);
  assert.match(installed.version, /^\d+\.\d+\.\d+/);
  const steps = t.events.filter((event) => event.type === "step").map((event) => (event.type === "step" ? `${event.step}:${event.state}` : ""));
  assert.ok(steps.some((step) => step.endsWith(":done")), "setup reported its steps");
  assert.deepEqual(t.events.at(-1)?.type, "finished");
  const registered = t.registry.get(t.hostId);
  assert.equal(registered?.port, t.port);
  assert.equal(registered?.version, installed.version);
  assert.ok(t.registry.token(t.hostId), "the key is kept here, encrypted by the app's own cipher");

  // It is up, and the app reaches it only through an SSH forward: the engine listens on the server's loopback.
  const view = await t.service.status(t.hostId);
  assert.equal(view.signedIn, true);
  assert.equal(view.agentFound, true);
  assert.ok(t.ssh.forwards.includes(t.port), "the connection went through SSH, to the engine's port on the server");
  await assert.rejects(() => new EngineClient({ host: "127.0.0.1", port: t.port, token: "x".repeat(40), label: "no key" }).status(), /./, "a wrong key is refused");

  const bot = makeBot({ id: "bot_e2e", hostId: t.hostId });
  const runtime = t.service.runtime(bot);
  assert.deepEqual(await runtime.health(), { ok: true, version: installed.version });

  const ran = await runtime.exec({ command: "echo from-the-server; pwd" });
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /from-the-server/);
  assert.match(ran.stdout, /bot_e2e/, "commands run in the Bot's own folder on the server");

  await runtime.writeFile("notes/today.txt", "remember the milk");
  assert.equal(await runtime.readFile("notes/today.txt"), "remember the milk");
  assert.deepEqual((await runtime.listFiles("notes")).map((entry) => entry.path), ["notes/today.txt"]);
  await runtime.removeFile("notes", { recursive: true });
  assert.deepEqual(await runtime.listFiles(""), []);

  const lines: string[] = [];
  const outcome = await runtime.run({ prompt: "say hello", model: "GLM-5.2", mode: "read_only" }, (line) => lines.push(line));
  assert.equal(outcome.reason, "completed");
  assert.ok(lines.length > 0, "the agent's output reached the app as it came");

  // Forgetting the Bot takes its folder off the server.
  assert.equal(await t.service.removeBot(bot), true);
});

test("taking the engine off a server stops it, forgets its key, and leaves nothing answering", async () => {
  const t = await setup();
  await t.service.install(t.hostId);
  assert.equal((await t.service.status(t.hostId)).signedIn, true);
  const key = t.registry.token(t.hostId);
  assert.ok(key);
  const direct = new EngineClient({ host: "127.0.0.1", port: t.port, token: key, label: "Dell" });
  assert.equal((await direct.status()).apiVersion, 1, "it answers before");

  await t.service.uninstall(t.hostId, true);
  assert.equal(t.registry.get(t.hostId), undefined);
  assert.equal(t.registry.token(t.hostId), null);
  assert.equal(existsSync(join(t.fake.home, ".deyin-bot")), false, "the engine's own folder is gone with purge");
  await assert.rejects(() => t.service.client(t.hostId), /No Bot engine is set up on Dell/);
  await assert.rejects(() => direct.status(), /./, "and nothing answers on its port afterwards");
});

test("a server whose key is not pinned is refused before anything is run on it", async () => {
  const t = await setup();
  const stored = t.hosts.get(t.hostId);
  assert.ok(stored);
  delete stored.knownHostFingerprint;
  await assert.rejects(() => t.service.install(t.hostId), /host key is not pinned/);
  assert.deepEqual(t.ssh.execs, [], "nothing ran on the server");
});

test("a server that answers with a different key than the one pinned is not trusted", async () => {
  const t = await setup();
  t.hosts.setKnownFingerprint(t.hostId, "SHA256:someoneElse");
  await assert.rejects(() => t.service.install(t.hostId));
  assert.deepEqual(t.ssh.execs, [], "no script was sent to a machine that is not the one the person saved");
});
