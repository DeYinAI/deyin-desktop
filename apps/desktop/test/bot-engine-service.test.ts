import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "ssh2";
import {
  BotError,
  ENGINE_DEFAULT_PORT,
  type EngineRegistration,
  type EngineSetupEvent,
  type EngineStatus,
  type EngineSupervisor,
  type SshHostInfo,
} from "@deyin/host-core";
import type { EngineClient } from "../src/main/bots/engine/client.js";
import type { InstallOptions, UninstallOptions } from "../src/main/bots/engine/installer.js";
import { BotEngineService, type EngineServiceDeps, type ServiceRegistry } from "../src/main/bots/engine/service.js";
import { makeBot } from "./helpers/bots.js";

function host(over: Partial<SshHostInfo> = {}): SshHostInfo {
  return { id: "host_1", label: "Dell", host: "dell.example.com", port: 22, username: "anh", authMethod: "privateKey", knownHostFingerprint: "SHA256:abc", ...over } as SshHostInfo;
}

class FakeRegistry implements ServiceRegistry {
  readonly entries = new Map<string, EngineRegistration & { token: string }>();
  private listeners = new Set<() => void>();
  list = () => [...this.entries.values()].map(({ token: _token, ...rest }) => rest as EngineRegistration);
  get = (hostId: string) => {
    const found = this.entries.get(hostId);
    if (!found) return undefined;
    const { token: _token, ...rest } = found;
    return rest as EngineRegistration;
  };
  token = (hostId: string) => this.entries.get(hostId)?.token ?? null;
  save(input: { hostId: string; port?: number; token: string; supervisor: EngineSupervisor; survivesReboot: boolean; version?: string }): EngineRegistration {
    const entry = { hostId: input.hostId, port: input.port ?? ENGINE_DEFAULT_PORT, supervisor: input.supervisor, survivesReboot: input.survivesReboot, installedAt: 1_000, token: input.token, ...(input.version ? { version: input.version } : {}) };
    this.entries.set(input.hostId, entry as EngineRegistration & { token: string });
    for (const listener of [...this.listeners]) listener();
    return this.get(input.hostId)!;
  }
  setVersion(hostId: string, version: string): void {
    const entry = this.entries.get(hostId);
    if (entry) entry.version = version;
  }
  remove(hostId: string): boolean {
    const had = this.entries.delete(hostId);
    if (had) for (const listener of [...this.listeners]) listener();
    return had;
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const STATUS: EngineStatus = { apiVersion: 1, version: "1.4.0", startedAt: 5, agent: { found: true, version: "0.9.0", signedIn: true }, bots: [{ botId: "bot_1", routines: 2, running: 1 }], runningNow: 1 };

function rig(options: { hosts?: SshHostInfo[]; connect?: (hostId: string) => Promise<Client>; install?: (options: InstallOptions) => Promise<{ version: string; warnings: string[] } & Record<string, unknown>>; uninstall?: (options: UninstallOptions) => Promise<unknown> } = {}) {
  const registry = new FakeRegistry();
  const events: EngineSetupEvent[] = [];
  const ended: number[] = [];
  const closed: string[] = [];
  const connected = new Set<string>();
  const state = { closedAll: 0, removeBotResult: true as boolean | Error, hosts: options.hosts ?? [host()], bots: [makeBot()] };
  let clientCalls = 0;
  const engine = {
    status: async () => STATUS,
    removeBot: async (botId: string) => {
      if (state.removeBotResult instanceof Error) throw state.removeBotResult;
      void botId;
      return state.removeBotResult;
    },
    health: async () => ({ ok: true, version: "1.4.0" }),
  } as unknown as EngineClient;
  const installs: InstallOptions[] = [];
  const uninstalls: UninstallOptions[] = [];
  const deps: EngineServiceDeps = {
    registry,
    hosts: { list: () => state.hosts },
    bots: { list: () => state.bots },
    connect: options.connect ?? (async () => ({ end: () => ended.push(1) }) as unknown as Client),
    filesDir: (botId) => `/data/${botId}/files`,
    emit: (event) => events.push(event),
    shellOf: () => ({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }),
    installer: {
      install: async (installOptions) => {
        installs.push(installOptions);
        return ((await options.install?.(installOptions)) ?? { version: "1.4.0", warnings: [] }) as Awaited<ReturnType<NonNullable<EngineServiceDeps["installer"]>["install"]>>;
      },
      uninstall: async (uninstallOptions) => {
        uninstalls.push(uninstallOptions);
        return (await options.uninstall?.(uninstallOptions)) as Awaited<ReturnType<NonNullable<EngineServiceDeps["installer"]>["uninstall"]>>;
      },
    },
    links: {
      client: async () => {
        clientCalls += 1;
        return engine;
      },
      isConnected: (hostId) => connected.has(hostId),
      close: (hostId) => {
        closed.push(hostId);
      },
      closeAll: () => {
        state.closedAll += 1;
      },
    },
  };
  const service = new BotEngineService(deps);
  return { service, registry, events, ended, closed, connected, state, installs, uninstalls, engine, clientCalls: () => clientCalls };
}

const REGISTRATION = { port: 7790, token: "t".repeat(64), supervisor: "systemd" as const, survivesReboot: true };

test("a server is listed with its address, whether its key is pinned, its engine if it has one, and how many Bots live there", () => {
  const t = rig({ hosts: [host(), host({ id: "host_2", label: "Pi", host: "pi.local", port: 2222, username: "pi", knownHostFingerprint: undefined })] });
  t.state.bots = [makeBot({ id: "a", handle: "a" }), makeBot({ id: "b", handle: "b" }), makeBot({ id: "c", handle: "c", hostId: "host_2" }), makeBot({ id: "d", handle: "d", harness: "local", hostId: undefined })];
  t.registry.save({ hostId: "host_1", port: 7791, token: "x".repeat(40), supervisor: "nohup", survivesReboot: false, version: "1.4.0" });
  t.connected.add("host_1");
  const [dell, pi] = t.service.list();
  assert.deepEqual(dell, {
    hostId: "host_1",
    label: "Dell",
    address: "anh@dell.example.com",
    pinned: true,
    engine: { port: 7791, version: "1.4.0", supervisor: "nohup", survivesReboot: false, installedAt: 1_000, connected: true },
    bots: 2,
  });
  assert.deepEqual(pi, { hostId: "host_2", label: "Pi", address: "pi@pi.local:2222", pinned: false, bots: 1 });
  assert.ok(!("engine" in pi!), "no engine, no engine entry");
});

test("setting up a server whose key is not pinned is refused, in words, before anything is tried", async () => {
  const t = rig({ hosts: [host({ knownHostFingerprint: undefined })] });
  await assert.rejects(
    () => t.service.install("host_1"),
    (error: unknown) => error instanceof BotError && error.code === "invalid" && /Dell's host key is not pinned yet/.test(error.message),
  );
  await assert.rejects(() => t.service.install("gone"), (error: unknown) => error instanceof BotError && error.code === "not_found");
  assert.equal(t.installs.length, 0);
  assert.deepEqual(t.events, []);
});

test("setting up runs the installer with a new key and the default port, and keeps what it registers", async () => {
  const t = rig({
    install: async (options) => {
      options.onProgress({ step: "download", state: "running", message: "Fetching" });
      options.onSignIn({ url: "https://openference.com/device?user_code=ABCD", code: "ABCD" });
      options.register(REGISTRATION);
      const status = await options.verify();
      assert.equal(status.version, "1.4.0");
      return { version: "1.4.0", warnings: ["no cron"] };
    },
  });
  assert.deepEqual(await t.service.install("host_1"), { version: "1.4.0", warnings: ["no cron"] });
  const [options] = t.installs;
  assert.ok(options);
  assert.ok(options.token.length >= 32, "a fresh key is made");
  assert.equal(options.port, ENGINE_DEFAULT_PORT);
  assert.deepEqual(t.events, [
    { type: "step", hostId: "host_1", step: "download", state: "running", message: "Fetching" },
    { type: "sign-in", hostId: "host_1", url: "https://openference.com/device?user_code=ABCD", code: "ABCD" },
    { type: "finished", hostId: "host_1", ok: true, version: "1.4.0", warnings: ["no cron"] },
  ]);
  const saved = t.registry.get("host_1");
  assert.deepEqual([saved?.port, saved?.supervisor, saved?.survivesReboot, saved?.version], [7790, "systemd", true, "1.4.0"]);
  assert.equal(t.registry.token("host_1"), REGISTRATION.token);
  assert.deepEqual(t.closed, ["host_1"], "a connection from before the key or port changed is dropped");
  assert.equal(t.ended.length, 1, "the SSH connection is always closed");
  assert.equal(t.service.list()[0]!.busy, undefined);
});

test("setting up again keeps the key and port the server already has", async () => {
  const t = rig();
  t.registry.save({ hostId: "host_1", port: 7800, token: "k".repeat(48), supervisor: "systemd", survivesReboot: true });
  await t.service.install("host_1");
  assert.equal(t.installs[0]!.token, "k".repeat(48));
  assert.equal(t.installs[0]!.port, 7800);
});

test("a setup that fails says so in a finished event, is thrown, and leaves nothing running or open", async () => {
  const t = rig({
    install: async () => {
      throw new BotError("conflict", "Downloading the engine failed on the server (exit 22).");
    },
  });
  await assert.rejects(() => t.service.install("host_1"), /Downloading the engine failed/);
  assert.deepEqual(t.events, [{ type: "finished", hostId: "host_1", ok: false, message: "Downloading the engine failed on the server (exit 22)." }]);
  assert.equal(t.ended.length, 1);
  assert.equal(t.service.list()[0]!.busy, undefined);
  assert.equal(t.registry.get("host_1"), undefined);
});

test("a server that cannot be reached is a refusal in words, and a refusal that already is words is left as it is", async () => {
  const unreachable = rig({
    connect: async () => {
      throw new Error("connect ETIMEDOUT");
    },
  });
  await assert.rejects(
    () => unreachable.service.install("host_1"),
    (error: unknown) => error instanceof BotError && error.code === "conflict" && error.message === "Could not connect to Dell: connect ETIMEDOUT",
  );
  assert.equal(unreachable.events.at(-1)?.type, "finished");
  const refused = rig({
    connect: async () => {
      throw new BotError("invalid", "The host key changed.");
    },
  });
  await assert.rejects(() => refused.service.install("host_1"), (error: unknown) => error instanceof BotError && error.code === "invalid" && error.message === "The host key changed.");
});

test("while a setup runs the server shows as busy, a second is refused, and another server is not held up", async () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = rig({
    hosts: [host(), host({ id: "host_2", label: "Pi" })],
    install: async () => {
      await hold;
      return { version: "1.4.0", warnings: [] };
    },
  });
  // An engine already set up here, so that taking it off is a real request that the running setup can hold up.
  t.registry.save({ hostId: "host_1", token: "k".repeat(40), supervisor: "nohup", survivesReboot: false });
  const first = t.service.install("host_1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.service.list()[0]!.busy, "installing");
  assert.equal(t.service.list()[1]!.busy, undefined);
  await assert.rejects(() => t.service.install("host_1"), (error: unknown) => error instanceof BotError && error.code === "conflict" && /already running on Dell/.test(error.message));
  await assert.rejects(() => t.service.uninstall("host_1", false), (error: unknown) => error instanceof BotError && error.code === "conflict" && /already running on Dell/.test(error.message));
  release();
  await first;
  assert.equal(t.service.list()[0]!.busy, undefined);
  await t.service.install("host_2");
});

test("cancelling stops a setup that is running and says whether there was one", async () => {
  let signal: AbortSignal | undefined;
  const t = rig({
    install: async (options) => {
      signal = options.signal;
      await new Promise((resolve) => options.signal?.addEventListener("abort", resolve));
      throw new BotError("conflict", "Cancelled.");
    },
  });
  assert.equal(t.service.cancel("host_1"), false);
  const running = t.service.install("host_1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.service.cancel("host_1"), true);
  await assert.rejects(() => running, /Cancelled/);
  assert.equal(signal?.aborted, true);
  assert.equal(t.service.cancel("host_1"), false, "nothing left to cancel");
});

test("people are told when a setup starts and ends, so the page can follow it", async () => {
  const t = rig();
  let changes = 0;
  const stop = t.service.onChange(() => {
    changes += 1;
  });
  await t.service.install("host_1");
  assert.ok(changes >= 2, `claimed and released (${changes})`);
  stop();
  const before = changes;
  await t.service.install("host_1");
  assert.equal(changes, before, "a stopped listener hears nothing");
});

test("taking the engine off asks the installer, with or without the Bots' files, and forgets the server's engine afterwards", async () => {
  const t = rig();
  t.registry.save({ hostId: "host_1", token: "k".repeat(40), supervisor: "systemd", survivesReboot: true });
  await t.service.uninstall("host_1", true);
  assert.equal(t.uninstalls[0]!.purge, true);
  assert.equal(t.registry.get("host_1"), undefined);
  assert.deepEqual(t.closed, ["host_1"]);
  assert.equal(t.ended.length, 1);
  t.registry.save({ hostId: "host_1", token: "k".repeat(40), supervisor: "systemd", survivesReboot: true });
  await t.service.uninstall("host_1", false);
  assert.equal(t.uninstalls[1]!.purge, false);
});

test("there is nothing to take off a server that has no engine", async () => {
  const t = rig();
  await assert.rejects(() => t.service.uninstall("host_1", false), (error: unknown) => error instanceof BotError && error.code === "not_found" && /no Bot engine on Dell/.test(error.message));
  await assert.rejects(() => t.service.uninstall("gone", false), (error: unknown) => error instanceof BotError && error.code === "not_found");
  assert.equal(t.uninstalls.length, 0);
});

test("a removal that fails keeps the engine registered, so it can be tried again", async () => {
  const t = rig({
    uninstall: async () => {
      throw new BotError("conflict", "Removing the engine failed on the server (exit 1).");
    },
  });
  t.registry.save({ hostId: "host_1", token: "k".repeat(40), supervisor: "systemd", survivesReboot: true });
  await assert.rejects(() => t.service.uninstall("host_1", true), /Removing the engine failed/);
  assert.ok(t.registry.get("host_1"));
  assert.equal(t.ended.length, 1);
  assert.equal(t.service.list()[0]!.busy, undefined);
});

test("forgetting a server's engine drops its connection and its registration without reaching the server", () => {
  const t = rig();
  t.registry.save({ hostId: "host_1", token: "k".repeat(40), supervisor: "systemd", survivesReboot: true });
  assert.equal(t.service.forget("host_1"), true);
  assert.equal(t.service.forget("host_1"), false);
  assert.deepEqual(t.closed, ["host_1", "host_1"]);
  assert.equal(t.ended.length, 0);
});

test("engines of servers that are no longer saved are forgotten, and the others kept", () => {
  const t = rig({ hosts: [host()] });
  for (const hostId of ["host_1", "removed_1", "removed_2"]) t.registry.save({ hostId, token: "k".repeat(40), supervisor: "systemd", survivesReboot: true });
  assert.equal(t.service.prune(), 2);
  assert.deepEqual(t.registry.list().map((entry) => entry.hostId), ["host_1"]);
  assert.equal(t.service.prune(), 0);
});

test("the engine's status is shown as the page needs it, and its version is remembered", async () => {
  const t = rig();
  t.registry.save({ hostId: "host_1", token: "k".repeat(40), supervisor: "systemd", survivesReboot: true });
  assert.deepEqual(await t.service.status("host_1"), {
    version: "1.4.0",
    startedAt: 5,
    agentFound: true,
    agentVersion: "0.9.0",
    signedIn: true,
    runningNow: 1,
    bots: [{ botId: "bot_1", routines: 2, running: 1 }],
  });
  assert.equal(t.registry.get("host_1")?.version, "1.4.0");
});

test("a Bot that moved off a server has its copy there removed, and a failure to do so is never raised", async () => {
  const t = rig();
  const onServer = { id: "bot_1", harness: "server" as const, hostId: "host_1" };
  assert.equal(await t.service.removeBot(onServer), false, "no engine, nothing to remove");
  t.registry.save({ hostId: "host_1", token: "k".repeat(40), supervisor: "systemd", survivesReboot: true });
  assert.equal(await t.service.removeBot(onServer), true);
  assert.equal(await t.service.removeBot({ id: "bot_1", harness: "local", hostId: undefined }), false);
  assert.equal(await t.service.removeBot({ id: "bot_1", harness: "server", hostId: undefined }), false);
  t.state.removeBotResult = new Error("connection lost");
  assert.equal(await t.service.removeBot(onServer), false);
});

test("a Bot's runtime is the one for its computer, and a server Bot is named by its server", () => {
  const t = rig();
  const server = t.service.runtime(makeBot());
  assert.equal(server.kind, "server");
  assert.equal(server.home, "~/.deyin-bot/bots/bot_1/files");
  const local = t.service.runtime(makeBot({ harness: "local", hostId: undefined }));
  assert.equal(local.kind, "local");
  assert.equal(local.home, "/data/bot_1/files");
  assert.equal(t.service.label(makeBot()), "Dell");
  assert.equal(t.service.label(makeBot({ hostId: "removed" })), "that server");
  assert.equal(t.service.label(makeBot({ harness: "local", hostId: undefined })), "its server");
});

test("health is a yes or a reason, never a throw, even for a Bot with nowhere to run", async () => {
  const t = rig();
  assert.deepEqual(await t.service.health(makeBot()), { ok: true, version: "1.4.0" });
  const nowhere = await t.service.health(makeBot({ hostId: undefined }));
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.reason ?? "", /no server is chosen/);
});

test("closing the service stops what is running and lets go of every connection", async () => {
  let signal: AbortSignal | undefined;
  const t = rig({
    install: async (options) => {
      signal = options.signal;
      await new Promise((resolve) => options.signal?.addEventListener("abort", resolve));
      throw new BotError("conflict", "Cancelled.");
    },
  });
  const running = t.service.install("host_1");
  await new Promise((resolve) => setImmediate(resolve));
  t.service.dispose();
  await assert.rejects(() => running, /Cancelled/);
  assert.equal(signal?.aborted, true);
  assert.equal(t.state.closedAll, 1);
});
