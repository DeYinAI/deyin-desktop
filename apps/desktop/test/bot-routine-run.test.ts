import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotMemory, BotSkillStore, BotStore, FileStorage, resolveLimits, type Automation, type AgentUiEvent, type BotRuntime, type RuntimeRunRequest } from "@deyin/host-core";
import { runOnBotsServer, type ServerRoutineSource } from "../src/main/bots/engine/routine-run.js";
import type { BotRunSource } from "../src/main/bots/run.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "deyin-routinerun-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const bots: BotRunSource = { store, botsDir: join(dir, "bots") };
  const requests: RuntimeRunRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const asked: string[] = [];
  const memory = { enabled: true };
  const runtime = {
    run: async (request: RuntimeRunRequest, onLine: (line: string) => void, signal?: AbortSignal) => {
      requests.push(request);
      signals.push(signal);
      onLine(JSON.stringify({ type: "text-delta", delta: "Checked." }));
      return { reason: "completed" as const, finalText: "Checked." };
    },
  } as unknown as BotRuntime;
  const source: ServerRoutineSource = {
    bots,
    servers: {
      runtime: (bot) => {
        asked.push(bot.id);
        return runtime;
      },
      label: () => "Dell",
    },
    isCustomProvider: (providerId) => providerId === "mine",
    memoryEnabled: () => memory.enabled,
  };
  return { store, bots, source, requests, signals, asked, memory };
}

function automation(botId: string | undefined, over: Partial<Automation> = {}): Automation {
  return {
    id: "auto_1",
    ...(botId ? { botId } : {}),
    name: "Morning digest",
    enabled: true,
    payload: { kind: "prompt", prompt: "Summarise my inbox." },
    trigger: { kind: "manual" },
    target: { kind: "local", workspacePath: "/x" },
    model: "glm-5.2",
    providerId: "openference",
    createdAt: 1,
    updatedAt: 1,
    limits: { maxMinutes: 7, maxSteps: 33 },
    ...over,
  };
}

function run(t: ReturnType<typeof setup>, over: Partial<Automation>, resolved: { prompt: string; subagent?: never } = { prompt: "Summarise my inbox." }, source: ServerRoutineSource = t.source) {
  const events: AgentUiEvent[] = [];
  const controller = new AbortController();
  const ctx = { limits: resolveLimits({ limits: over.limits ?? automation(undefined).limits }), emit: (event: AgentUiEvent) => events.push(event), signal: controller.signal };
  return { events, controller, done: (botId: string | undefined) => runOnBotsServer(automation(botId, over), resolved as never, ctx, source) };
}

test("a routine that is not a Bot's, or whose Bot is on this computer, is left for the caller to run", async () => {
  const t = setup();
  const local = t.store.create({ name: "Local" });
  assert.equal(await run(t, {}).done(undefined), null);
  assert.equal(await run(t, {}).done(local.id), null);
  assert.equal(await run(t, {}, undefined, { ...t.source, bots: undefined }).done(local.id), null, "without Bots there is no Bot to look up");
  assert.deepEqual(t.asked, []);
});

test("a routine of a Bot on a server runs there, as the Bot, with the routine's own model and limits", async () => {
  const t = setup();
  const bot = t.store.create({ name: "Ada", harness: "server", hostId: "host_1" });
  new BotMemory(t.bots.botsDir, bot.id).create({ title: "Boss", type: "user", body: "Grace" });
  const r = run(t, {});
  const result = await r.done(bot.id);
  assert.deepEqual(result, { reason: "completed", finalText: "Checked." });
  assert.deepEqual(t.asked, [bot.id]);
  const [request] = t.requests;
  assert.ok(request);
  assert.equal(request.model, "glm-5.2");
  assert.equal(request.maxSteps, 33);
  assert.equal(request.timeoutMs, 7 * 60_000);
  assert.match(request.prompt, /You are Ada/);
  assert.match(request.prompt, /Your routine "Morning digest" is running now/);
  assert.match(request.prompt, /- Boss\n {2}Grace/);
  assert.ok(request.prompt.endsWith("Summarise my inbox."));
  assert.equal(t.signals[0], r.controller.signal);
  assert.deepEqual(r.events.map((event) => event.type), ["text-delta", "done"]);
});

test("a routine on the person's own model endpoint is refused for a server Bot", async () => {
  const t = setup();
  const bot = t.store.create({ name: "Ada", harness: "server", hostId: "host_1" });
  await assert.rejects(() => run(t, { providerId: "mine" }).done(bot.id), /only use models served by Openference/);
  assert.deepEqual(t.requests, []);
});

test("a routine that hands work to a subagent, or runs where servers are unavailable, fails in words", async () => {
  const t = setup();
  const bot = t.store.create({ name: "Ada", harness: "server", hostId: "host_1" });
  await assert.rejects(() => run(t, {}, { prompt: "x", subagent: {} as never }).done(bot.id), /subagent runs only on this computer/);
  await assert.rejects(() => run(t, {}, undefined, { ...t.source, servers: undefined }).done(bot.id), /Servers are not available in this window/);
  assert.deepEqual(t.requests, []);
});

test("a routine of a Bot that was deleted or archived fails clearly, even if it was a server Bot", async () => {
  const t = setup();
  const bot = t.store.create({ name: "Ada", harness: "server", hostId: "host_1" });
  t.store.archive(bot.id);
  await assert.rejects(() => run(t, {}).done(bot.id), /Ada is archived/);
  await assert.rejects(() => run(t, {}).done("gone"), /no longer exists/);
  assert.deepEqual(t.asked, []);
});

test("with memory switched off the Bot is told nothing it remembers, as in chat", async () => {
  const t = setup();
  const bot = t.store.create({ name: "Ada", harness: "server", hostId: "host_1" });
  new BotMemory(t.bots.botsDir, bot.id).create({ title: "Boss", type: "user", body: "Grace" });
  t.memory.enabled = false;
  await run(t, {}).done(bot.id);
  assert.doesNotMatch(t.requests[0]!.prompt, /bot_memory|Grace/);
  t.memory.enabled = true;
  await run(t, {}).done(bot.id);
  assert.match(t.requests[1]!.prompt, /Grace/);
});

test("the Bot's skills are sent with a routine that runs on its server", async () => {
  const t = setup();
  const bot = t.store.create({ name: "Ada", harness: "server", hostId: "host_1" });
  await new BotSkillStore(join(t.store.dataDir(bot.id), "skills")).save(
    { name: "digest", description: "Make the digest", body: "1. Read the mail\n2. Keep it short" },
    { author: "person", origin: "person" },
  );
  await run(t, {}).done(bot.id);
  assert.match(t.requests[0]!.prompt, /## digest: Make the digest\n1\. Read the mail\n2\. Keep it short/);
  const other = t.store.create({ name: "Grace", harness: "server", hostId: "host_1" });
  await run(t, {}).done(other.id);
  assert.doesNotMatch(t.requests[1]!.prompt, /bot_skills/, "another Bot's skills are not sent to this one");
});
