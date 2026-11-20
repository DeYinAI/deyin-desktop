import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ENGINE_DEFAULT_PORT } from "../src/bots/engine-protocol.js";
import { ENGINE_TOKEN_MIN_LENGTH, EngineRegistryStore, generateEngineToken } from "../src/bots/engine-registry.js";
import { BotError } from "../src/bots/types.js";
import { FileStorage, type SecretCipher } from "../src/storage.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((s) => s.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const rot: SecretCipher = {
  encrypt: (plain) => `enc:${Buffer.from(plain).toString("base64")}`,
  decrypt: (stored) => (stored.startsWith("enc:") ? Buffer.from(stored.slice(4), "base64").toString() : null),
};

const FILE = "bot-engines.json";
const TOKEN = "t".repeat(40);

function open(dir = mkdtempSync(join(tmpdir(), "deyin-engines-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const storage = new FileStorage(dir, rot);
  storages.push(storage);
  let clock = 5_000;
  const store = new EngineRegistryStore(storage, { now: () => (clock += 100) });
  return { dir, storage, store };
}

const refuses = (fn: () => unknown, pattern: RegExp): void => {
  assert.throws(fn, (error) => error instanceof BotError && error.code === "invalid" && pattern.test(error.message));
};

test("a new registry is empty and writes nothing", async () => {
  const h = open();
  assert.deepEqual(h.store.list(), []);
  assert.equal(h.store.get("h1"), undefined);
  assert.equal(h.store.token("h1"), null);
  await h.storage.flush();
  assert.throws(() => readFileSync(join(h.dir, FILE)));
});

test("an engine is kept with its port and how it stays running, and the default port applies", () => {
  const h = open();
  const saved = h.store.save({ hostId: "h1", token: TOKEN, supervisor: "systemd", survivesReboot: true, version: "1.2.3" });
  assert.deepEqual(saved, { hostId: "h1", port: ENGINE_DEFAULT_PORT, installedAt: 5_100, supervisor: "systemd", survivesReboot: true, version: "1.2.3" });
  assert.deepEqual(h.store.get("h1"), saved);
  assert.deepEqual(h.store.list(), [saved]);
});

test("the key is encrypted on disk, never listed, and only `token` reads it back", async () => {
  const h = open();
  h.store.save({ hostId: "h1", token: TOKEN, supervisor: "nohup", survivesReboot: false });
  await h.storage.flush();
  const raw = readFileSync(join(h.dir, FILE), "utf8");
  assert.ok(!raw.includes(TOKEN), "the key is not on disk in the clear");
  assert.ok(raw.includes(rot.encrypt(TOKEN)));
  assert.ok(!JSON.stringify(h.store.list()).includes(TOKEN));
  assert.ok(!JSON.stringify(h.store.get("h1")).includes("enc:"), "not even the encrypted form is handed out");
  assert.equal(h.store.token("h1"), TOKEN);
  const again = open(h.dir);
  assert.equal(again.store.token("h1"), TOKEN, "it survives a restart");
});

test("a key that can no longer be decrypted reads as missing, not as garbage", async () => {
  const h = open();
  h.store.save({ hostId: "h1", token: TOKEN, supervisor: "systemd", survivesReboot: true });
  await h.storage.flush();
  const storage = new FileStorage(h.dir, { encrypt: rot.encrypt, decrypt: () => null });
  storages.push(storage);
  const store = new EngineRegistryStore(storage);
  assert.equal(store.get("h1")?.hostId, "h1");
  assert.equal(store.token("h1"), null);
});

test("saving again for the same host replaces it and keeps when it was first installed", () => {
  const h = open();
  const first = h.store.save({ hostId: "h1", token: TOKEN, port: 8000, supervisor: "nohup", survivesReboot: false, version: "1.0.0" });
  h.store.save({ hostId: "h2", token: TOKEN, supervisor: "systemd", survivesReboot: true });
  const second = h.store.save({ hostId: "h1", token: "u".repeat(40), port: 9000, supervisor: "systemd", survivesReboot: true });
  assert.equal(second.installedAt, first.installedAt);
  assert.equal(second.port, 9000);
  assert.equal(second.version, undefined, "a version from the old install is not carried over");
  assert.equal(h.store.token("h1"), "u".repeat(40));
  assert.equal(h.store.list().length, 2);
  assert.equal(h.store.token("h2"), TOKEN, "the other server is untouched");
});

test("what is not a usable engine is refused and nothing changes", async () => {
  const h = open();
  const listened: number[] = [];
  h.store.onChange(() => listened.push(1));
  refuses(() => h.store.save({ hostId: "", token: TOKEN, supervisor: "systemd", survivesReboot: true }), /Choose a server/);
  refuses(() => h.store.save({ hostId: "h1", token: "short", supervisor: "systemd", survivesReboot: true }), /at least 32/);
  refuses(() => h.store.save({ hostId: "h1", token: "x".repeat(ENGINE_TOKEN_MIN_LENGTH - 1), supervisor: "systemd", survivesReboot: true }), /at least 32/);
  refuses(() => h.store.save({ hostId: "h1", token: TOKEN, port: 80, supervisor: "systemd", survivesReboot: true }), /1024 to 65535/);
  refuses(() => h.store.save({ hostId: "h1", token: TOKEN, port: 65536, supervisor: "systemd", survivesReboot: true }), /1024 to 65535/);
  refuses(() => h.store.save({ hostId: "h1", token: TOKEN, port: 7790.5, supervisor: "systemd", survivesReboot: true }), /whole number/);
  refuses(() => h.store.save({ hostId: "h1", token: TOKEN, supervisor: "cron" as never, survivesReboot: true }), /how the engine is kept running/);
  h.store.save({ hostId: "h1", token: "x".repeat(ENGINE_TOKEN_MIN_LENGTH), port: 1024, supervisor: "systemd", survivesReboot: true });
  h.store.save({ hostId: "h2", token: TOKEN, port: 65535, supervisor: "nohup", survivesReboot: false });
  assert.equal(h.store.list().length, 2, "the edges are allowed");
  assert.equal(listened.length, 2, "only the saves that worked were announced");
  await h.storage.flush();
});

test("the version is updated when it changes, and ignored for a host with no engine", () => {
  const h = open();
  const listened: number[] = [];
  h.store.save({ hostId: "h1", token: TOKEN, supervisor: "systemd", survivesReboot: true });
  h.store.onChange(() => listened.push(1));
  h.store.setVersion("h1", "2.0.0");
  assert.equal(h.store.get("h1")?.version, "2.0.0");
  h.store.setVersion("h1", "2.0.0");
  h.store.setVersion("h1", "");
  h.store.setVersion("nope", "9.9.9");
  assert.equal(h.store.get("h1")?.version, "2.0.0");
  assert.equal(h.store.get("nope"), undefined);
  assert.equal(listened.length, 1, "no change, no announcement");
});

test("removing an engine forgets its key; removing one that is not there says so", async () => {
  const h = open();
  h.store.save({ hostId: "h1", token: TOKEN, supervisor: "systemd", survivesReboot: true });
  assert.equal(h.store.remove("h1"), true);
  assert.equal(h.store.remove("h1"), false);
  assert.equal(h.store.token("h1"), null);
  await h.storage.flush();
  assert.ok(!readFileSync(join(h.dir, FILE), "utf8").includes("enc:"));
});

test("a damaged file keeps the entries that are fine and drops the ones that are not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-engines-"));
  dirs.push(dir);
  const good = { hostId: "ok", port: 7790, installedAt: 1, supervisor: "systemd", survivesReboot: true, tokenCipher: rot.encrypt(TOKEN), version: "1.0.0" };
  writeFileSync(
    join(dir, FILE),
    JSON.stringify({
      servers: [
        good,
        null,
        "x",
        { ...good, hostId: "" },
        { ...good, hostId: 7 },
        { ...good, hostId: "dup" },
        { ...good, hostId: "dup", port: 8000 },
        { ...good, hostId: "no-cipher", tokenCipher: "" },
        { ...good, hostId: "bad-port", port: 22 },
        { ...good, hostId: "big-port", port: 70000 },
        { ...good, hostId: "float-port", port: 7790.5 },
        { ...good, hostId: "bad-time", installedAt: "yesterday" },
        { ...good, hostId: "bad-sup", supervisor: "cron" },
        { ...good, hostId: "no-reboot", survivesReboot: "yes", version: "" },
      ],
    }),
  );
  const h = open(dir);
  assert.deepEqual(h.store.list().map((s) => s.hostId), ["ok", "dup", "no-reboot"]);
  assert.equal(h.store.get("dup")?.port, 7790, "the first of two with the same host wins");
  assert.equal(h.store.get("no-reboot")?.survivesReboot, false, "only a real true counts");
  assert.equal(h.store.get("no-reboot")?.version, undefined);
  assert.equal(h.store.get("ok")?.version, "1.0.0");
  const garbage = mkdtempSync(join(tmpdir(), "deyin-engines-"));
  dirs.push(garbage);
  writeFileSync(join(garbage, FILE), "[1,2,3]");
  assert.deepEqual(open(garbage).store.list(), []);
  writeFileSync(join(garbage, FILE), JSON.stringify({ servers: "no" }));
  assert.deepEqual(open(garbage).store.list(), []);
});

test("a listener can stop listening", () => {
  const h = open();
  const heard: number[] = [];
  const stop = h.store.onChange(() => heard.push(1));
  h.store.save({ hostId: "h1", token: TOKEN, supervisor: "systemd", survivesReboot: true });
  stop();
  h.store.save({ hostId: "h2", token: TOKEN, supervisor: "systemd", survivesReboot: true });
  assert.equal(heard.length, 1);
});

test("generated keys are long, hex and different every time", () => {
  const a = generateEngineToken();
  const b = generateEngineToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.ok(a.length >= ENGINE_TOKEN_MIN_LENGTH);
});
