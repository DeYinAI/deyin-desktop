import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { startBotEngine, type RunningEngine } from "@deyin/bot-engine";
import { BotError, EngineRegistryStore, type SecretCipher } from "@deyin/host-core";
import { EngineClient } from "../src/main/bots/engine/client.js";
import { EngineLinks, forwardAgent, type ForwardingConnection } from "../src/main/bots/engine/links.js";

const FAKE_DEYIN = fileURLToPath(new URL("../../../packages/bot-engine/test/helpers/fake-deyin.mjs", import.meta.url));
const TOKEN = "k".repeat(40);

const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function engine(): Promise<RunningEngine> {
  const root = mkdtempSync(join(tmpdir(), "deyin-links-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "token"), TOKEN, { mode: 0o600 });
  const running = await startBotEngine({ version: "1.2.3", home, port: 0, deyin: { command: process.execPath, args: [FAKE_DEYIN] } });
  cleanups.push(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });
  return running;
}

/** A stream with none of a socket's extra methods, as an SSH channel is. */
function channelOver(socket: Socket): Duplex {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, _encoding, done) {
      socket.write(chunk, done);
    },
    final(done) {
      socket.end(done);
    },
    destroy(error, done) {
      socket.destroy();
      done(error);
    },
  });
  socket.on("data", (chunk) => {
    if (!stream.push(chunk)) socket.pause();
  });
  socket.on("end", () => stream.push(null));
  socket.on("error", (error) => stream.destroy(error));
  return stream;
}

class FakeConnection extends EventEmitter implements ForwardingConnection {
  readonly forwards: Array<{ host: string; port: number }> = [];
  ended = false;
  refuseNext: Error | undefined;
  constructor(private readonly enginePort: number) {
    super();
  }
  forwardOut(_srcIP: string, _srcPort: number, dstIP: string, dstPort: number, callback: (err: Error | undefined, channel: Duplex) => void): void {
    this.forwards.push({ host: dstIP, port: dstPort });
    if (this.refuseNext) {
      const error = this.refuseNext;
      this.refuseNext = undefined;
      queueMicrotask(() => callback(error, undefined as never));
      return;
    }
    const socket = connect(this.enginePort, "127.0.0.1");
    socket.once("connect", () => callback(undefined, channelOver(socket)));
    socket.once("error", (error) => callback(error, undefined as never));
  }
  end(): void {
    this.ended = true;
  }
}

const rot: SecretCipher = {
  encrypt: (plain) => `enc:${Buffer.from(plain).toString("base64")}`,
  decrypt: (stored) => (stored.startsWith("enc:") ? Buffer.from(stored.slice(4), "base64").toString() : null),
};

function registry(): EngineRegistryStore {
  return new EngineRegistryStore({ readJson: <T>(_name: string, fallback: T) => fallback, writeJson: () => undefined, cipher: rot });
}

interface Harness {
  links: EngineLinks;
  registry: EngineRegistryStore;
  connections: FakeConnection[];
  connects: () => number;
  failConnect: (error: Error | undefined) => void;
  gate: (promise: Promise<void> | undefined) => void;
}

function harness(running: RunningEngine): Harness {
  const reg = registry();
  reg.save({ hostId: "h1", token: TOKEN, port: running.port, supervisor: "systemd", survivesReboot: true });
  const connections: FakeConnection[] = [];
  let failure: Error | undefined;
  let gated: Promise<void> | undefined;
  const links = new EngineLinks({
    registry: reg,
    labelOf: (hostId) => (hostId === "h1" ? "Dell box" : hostId),
    connect: async () => {
      if (gated) await gated;
      if (failure) throw failure;
      const connection = new FakeConnection(running.port);
      connections.push(connection);
      return connection;
    },
  });
  cleanups.push(() => links.closeAll());
  return { links, registry: reg, connections, connects: () => connections.length, failConnect: (e) => (failure = e), gate: (p) => (gated = p) };
}

async function refused(promise: Promise<unknown>, code: BotError["code"]): Promise<BotError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BotError, `a BotError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail("expected a refusal");
}

test("a call goes out through the forward to the engine's port on the server's loopback", async () => {
  const running = await engine();
  const h = harness(running);
  const client = await h.links.client("h1");
  assert.deepEqual(await client.health(), { ok: true, apiVersion: 1, version: "1.2.3" });
  assert.equal((await client.status()).version, "1.2.3", "with the key");
  assert.deepEqual(h.connections[0]?.forwards[0], { host: "127.0.0.1", port: running.port });
});

test("a channel with none of a socket's extra methods still carries files, commands and a streamed run", async () => {
  const running = await engine();
  const h = harness(running);
  const client = await h.links.client("h1");
  await client.writeFile("b1", "note.txt", "héllo");
  assert.equal(await client.readFile("b1", "note.txt"), "héllo");
  const exec = await client.exec("b1", { command: "echo hi; echo oops >&2; exit 3" });
  assert.deepEqual({ code: exec.code, stdout: exec.stdout.trim(), stderr: exec.stderr.trim() }, { code: 3, stdout: "hi", stderr: "oops" });
  const lines: string[] = [];
  const outcome = await client.run("b1", { prompt: "ECHO over the wire", model: "m", mode: "read_only" }, (line) => lines.push(line));
  assert.equal(outcome.reason, "completed");
  assert.ok(lines.length > 0);
  assert.equal(h.connects(), 1, "all of it on one connection");
  assert.ok(h.connections[0]!.forwards.length >= 4, "a channel for each call");
});

test("the second call reuses the connection, and calls made together share one connect", async () => {
  const running = await engine();
  const h = harness(running);
  const [a, b, c] = await Promise.all([h.links.client("h1"), h.links.client("h1"), h.links.client("h1")]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(await h.links.client("h1"), a);
  assert.equal(h.connects(), 1);
  assert.equal(h.links.isConnected("h1"), true);
});

test("a server with no engine, or a key that cannot be read, is a clear message and no connection", async () => {
  const running = await engine();
  const h = harness(running);
  const missing = await refused(h.links.client("h2"), "not_found");
  assert.match(missing.message, /No Bot engine is set up on h2/);
  const unreadable = new EngineLinks({
    registry: { get: (hostId) => h.registry.get(hostId), token: () => null },
    labelOf: () => "Dell box",
    connect: async () => assert.fail("must not connect without a key"),
  });
  assert.match((await refused(unreadable.client("h1"), "conflict")).message, /key for the Bot engine on Dell box can no longer be read/);
  assert.equal(h.connects(), 0);
});

test("a connect that fails says so with the server's name, is not remembered, and the next call tries again", async () => {
  const running = await engine();
  const h = harness(running);
  h.failConnect(new Error("Host key verification failed"));
  assert.match((await refused(h.links.client("h1"), "conflict")).message, /Could not connect to Dell box: Host key verification failed/);
  assert.equal(h.links.isConnected("h1"), false);
  h.failConnect(undefined);
  assert.equal((await (await h.links.client("h1")).health()).ok, true);
  h.failConnect("a string" as never);
  h.links.close("h1");
  assert.match((await refused(h.links.client("h1"), "conflict")).message, /Could not connect to Dell box: a string/);
});

test("when the connection drops, the next call connects again", async () => {
  const running = await engine();
  const h = harness(running);
  const first = await h.links.client("h1");
  h.connections[0]!.emit("close");
  assert.equal(h.links.isConnected("h1"), false);
  const second = await h.links.client("h1");
  assert.notEqual(second, first);
  assert.equal(h.connects(), 2);
  assert.equal((await second.health()).ok, true);
  h.connections[1]!.emit("error", new Error("reset"));
  assert.equal(h.links.isConnected("h1"), false);
  assert.equal((await (await h.links.client("h1")).health()).ok, true);
  assert.equal(h.connects(), 3);
});

test("a late close from an old connection does not drop the one that replaced it", async () => {
  const running = await engine();
  const h = harness(running);
  await h.links.client("h1");
  const old = h.connections[0]!;
  h.links.close("h1");
  const fresh = await h.links.client("h1");
  old.emit("close");
  assert.equal(h.links.isConnected("h1"), true);
  assert.equal(await h.links.client("h1"), fresh);
  assert.equal(h.connects(), 2);
});

test("a changed port or key sets up a new connection and ends the old one", async () => {
  const running = await engine();
  const h = harness(running);
  const first = await h.links.client("h1");
  h.registry.save({ hostId: "h1", token: "z".repeat(40), port: running.port, supervisor: "systemd", survivesReboot: true });
  const second = await h.links.client("h1");
  assert.notEqual(second, first);
  assert.equal(h.connections[0]!.ended, true);
  await refused(second.status(), "conflict");
  h.registry.save({ hostId: "h1", token: TOKEN, port: running.port, supervisor: "systemd", survivesReboot: true });
  const third = await h.links.client("h1");
  assert.equal((await third.status()).version, "1.2.3");
  h.registry.save({ hostId: "h1", token: TOKEN, port: running.port + 1, supervisor: "systemd", survivesReboot: true });
  await h.links.client("h1");
  assert.equal(h.connects(), 4);
  assert.equal(h.connections[2]!.ended, true);
});

test("closing one server's connection ends it, leaves others alone, and closing everything ends all", async () => {
  const running = await engine();
  const h = harness(running);
  h.registry.save({ hostId: "h2", token: TOKEN, port: running.port, supervisor: "nohup", survivesReboot: false });
  await h.links.client("h1");
  await h.links.client("h2");
  h.links.close("h1");
  assert.equal(h.connections[0]!.ended, true);
  assert.equal(h.connections[1]!.ended, false);
  assert.equal(h.links.isConnected("h1"), false);
  assert.equal(h.links.isConnected("h2"), true);
  h.links.close("h1");
  h.links.closeAll();
  assert.equal(h.connections[1]!.ended, true);
  assert.equal(h.links.isConnected("h2"), false);
});

test("a connection that finishes opening after it was closed is ended, not kept", async () => {
  const running = await engine();
  const h = harness(running);
  let open!: () => void;
  h.gate(new Promise<void>((resolve) => (open = resolve)));
  const pending = refused(h.links.client("h1"), "conflict");
  h.links.close("h1");
  open();
  assert.match((await pending).message, /was closed before it was ready/);
  assert.equal(h.connections[0]!.ended, true);
  assert.equal(h.links.isConnected("h1"), false);
  h.gate(undefined);
  assert.equal((await (await h.links.client("h1")).health()).ok, true);
});

test("an engine that is not running is a message naming the server, and the connection stays", async () => {
  const running = await engine();
  const h = harness(running);
  const client = await h.links.client("h1");
  h.connections[0]!.refuseNext = new Error("(SSH) Channel open failure: Connection refused");
  const error = await refused(client.status(), "conflict");
  assert.match(error.message, /Could not reach the Bot engine on Dell box: .*Connection refused/);
  assert.equal(h.links.isConnected("h1"), true);
  assert.equal((await client.status()).version, "1.2.3", "and the next call goes through");
});

test("the forward agent opens a channel for every request and reuses none", async () => {
  const running = await engine();
  const connection = new FakeConnection(running.port);
  const agent = forwardAgent(connection, running.port);
  cleanups.push(() => agent.destroy());
  const client = new EngineClient({ host: "127.0.0.1", port: running.port, token: TOKEN, agent, label: "x" });
  await client.health();
  await client.health();
  await client.health();
  assert.equal(connection.forwards.length, 3);
});

test("a call that waited on a connection made for an out-of-date key gets a connection made for the current one", async () => {
  const running = await engine();
  const h = harness(running);
  h.registry.save({ hostId: "h1", token: "z".repeat(40), port: running.port, supervisor: "systemd", survivesReboot: true });
  let open!: () => void;
  h.gate(new Promise<void>((resolve) => (open = resolve)));
  const early = h.links.client("h1");
  h.registry.save({ hostId: "h1", token: TOKEN, port: running.port, supervisor: "systemd", survivesReboot: true });
  const late = h.links.client("h1");
  open();
  await early;
  assert.equal((await (await late).status()).version, "1.2.3", "the late caller got the right key");
  assert.equal(h.connects(), 2);
  assert.equal(h.connections[0]!.ended, true, "the out-of-date connection was ended");
});

test("a channel is handed to HTTP with the socket methods it may call, keeping any the channel has", async () => {
  const connection = new FakeConnection(1);
  const agent = forwardAgent(connection, 7790);
  cleanups.push(() => agent.destroy());
  const bare = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  const own = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } }) as Duplex & { setTimeout?: (ms: number) => unknown; setNoDelay?: (on: boolean) => unknown };
  let ownCalls = 0;
  own.setTimeout = () => {
    ownCalls += 1;
    return own;
  };
  own.setNoDelay = () => {
    ownCalls += 1;
    return own;
  };
  connection.forwardOut = (_a, _b, _c, _d, callback) => {
    callback(undefined, connection.forwards.length === 0 ? bare : own);
    connection.forwards.push({ host: "h", port: 1 });
  };
  const handed: Duplex[] = [];
  const take = (error: Error | null, stream: Duplex): void => {
    assert.equal(error, null);
    handed.push(stream);
  };
  assert.equal((agent.createConnection as (o: object, cb: typeof take) => unknown)({}, take), undefined, "answers through the callback");
  (agent.createConnection as (o: object, cb: typeof take) => unknown)({}, take);
  const socket = handed[0] as Duplex & Record<string, (...args: unknown[]) => unknown>;
  assert.equal(socket, bare);
  for (const name of ["setNoDelay", "setKeepAlive", "ref", "unref", "setTimeout"]) {
    assert.equal(typeof socket[name], "function", name);
    assert.equal(socket[name]!(1), bare, `${name} can be chained`);
  }
  const mine = handed[1] as typeof own;
  mine.setTimeout?.(5);
  mine.setNoDelay?.(true);
  assert.equal(ownCalls, 2, "methods the channel already has are left as they were");
});
