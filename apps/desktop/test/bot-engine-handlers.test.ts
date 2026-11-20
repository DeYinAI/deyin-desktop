import assert from "node:assert/strict";
import { test } from "node:test";
import { BotError, type DeyinBot, type EngineHostView, type EngineStatusView, type RuntimeHealth } from "@deyin/host-core";
import { createEngineHandlers, type EngineHandlerDeps } from "../src/main/bots/engine/handlers.js";
import { makeBot } from "./helpers/bots.js";

const STATUS: EngineStatusView = { version: "1.0.0", startedAt: 1, agentFound: true, signedIn: true, runningNow: 0, bots: [] };

function rig(over: Partial<EngineHandlerDeps["service"]> = {}, bots: DeyinBot[] = [makeBot()]) {
  const calls: Array<[string, ...unknown[]]> = [];
  const service: EngineHandlerDeps["service"] = {
    list: () => {
      calls.push(["list"]);
      return [{ hostId: "host_1", label: "Dell", address: "anh@dell", pinned: true, bots: 0 }] satisfies EngineHostView[];
    },
    status: async (hostId) => {
      calls.push(["status", hostId]);
      return STATUS;
    },
    install: async (hostId) => {
      calls.push(["install", hostId]);
      return { version: "1.0.0", warnings: [] };
    },
    cancel: (hostId) => {
      calls.push(["cancel", hostId]);
      return true;
    },
    uninstall: async (hostId, purge) => {
      calls.push(["uninstall", hostId, purge]);
    },
    forget: (hostId) => {
      calls.push(["forget", hostId]);
      return true;
    },
    health: async (bot): Promise<RuntimeHealth> => {
      calls.push(["health", bot.id]);
      return { ok: true, version: "1.0.0" };
    },
    ...over,
  };
  return { handlers: createEngineHandlers({ service, bots: { get: (id) => bots.find((bot) => bot.id === id) } }), calls };
}

function failed<T>(result: { ok: boolean } & Record<string, unknown>, pattern: RegExp, code: string): void {
  void (null as T | null);
  assert.equal(result.ok, false);
  assert.match(String(result.error), pattern);
  assert.equal(result.code, code);
}

test("the list and the calls that work go to the service, with their answers wrapped as results", async () => {
  const { handlers, calls } = rig();
  assert.equal(handlers.list().length, 1);
  assert.deepEqual(await handlers.status("host_1"), { ok: true, value: STATUS });
  assert.deepEqual(await handlers.install("host_1"), { ok: true, value: { version: "1.0.0", warnings: [] } });
  assert.deepEqual(await handlers.uninstall("host_1", true), { ok: true, value: null });
  assert.deepEqual(handlers.forget("host_1"), { ok: true, value: null });
  assert.deepEqual(await handlers.health("bot_1"), { ok: true, value: { ok: true, version: "1.0.0" } });
  assert.equal(handlers.cancel("host_1"), true);
  assert.deepEqual(calls, [["list"], ["status", "host_1"], ["install", "host_1"], ["uninstall", "host_1", true], ["forget", "host_1"], ["health", "bot_1"], ["cancel", "host_1"]]);
});

test("whatever the page sends is checked, and a bad value comes back as words without reaching the service", async () => {
  const { handlers, calls } = rig();
  for (const bad of [undefined, null, 5, "", {}, ["host_1"]]) {
    failed(await handlers.status(bad), /server is required/, "invalid");
    failed(await handlers.install(bad), /server is required/, "invalid");
    failed(await handlers.uninstall(bad, false), /server is required/, "invalid");
    failed(handlers.forget(bad), /server is required/, "invalid");
    failed(await handlers.health(bad), /Bot is required/, "invalid");
    assert.equal(handlers.cancel(bad), false);
  }
  for (const purge of [undefined, null, "true", 1, 0]) failed(await handlers.uninstall("host_1", purge), /Say whether to delete the Bots' files/, "invalid");
  assert.deepEqual(calls, []);
});

test("a refusal from the service is returned as words and its kind, never thrown across the page boundary", async () => {
  const { handlers } = rig({
    status: async () => {
      throw new BotError("conflict", "Could not connect to Dell: timed out");
    },
    install: async () => {
      throw new BotError("invalid", "Dell's host key is not pinned yet.");
    },
    uninstall: async () => {
      throw new BotError("not_found", "There is no Bot engine on Dell.");
    },
  });
  failed(await handlers.status("host_1"), /Could not connect to Dell/, "conflict");
  failed(await handlers.install("host_1"), /not pinned/, "invalid");
  failed(await handlers.uninstall("host_1", false), /no Bot engine/, "not_found");
});

test("something that is not a refusal is a bug and is still thrown", async () => {
  const { handlers } = rig({
    status: async () => {
      throw new TypeError("undefined is not a function");
    },
  });
  await assert.rejects(() => handlers.status("host_1"), TypeError);
});

test("forgetting an engine that was not there says so", () => {
  const { handlers } = rig({ forget: () => false });
  failed(handlers.forget("host_1"), /no Bot engine here to forget/, "not_found");
});

test("asking after a Bot that no longer exists says so, and a Bot with nowhere to run is answered, not thrown", async () => {
  const { handlers } = rig();
  failed(await handlers.health("ghost"), /no longer exists/, "not_found");
  const nowhere = rig({ health: async () => ({ ok: false, reason: "no server is chosen" }) });
  assert.deepEqual(await nowhere.handlers.health("bot_1"), { ok: true, value: { ok: false, reason: "no server is chosen" } });
});

test("cancel never throws and only counts as cancelled what the service cancelled", () => {
  const { handlers } = rig({ cancel: () => false });
  assert.equal(handlers.cancel("host_1"), false);
});
