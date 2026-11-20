import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BotError,
  EMPTY_PERMISSIONS,
  RUNTIME_LIMITS,
  type Automation,
  type AutomationRun,
  type BotPermissionSettings,
  type DeyinBot,
  type EngineRoutine,
  type EngineRoutineView,
  type EngineRunRecord,
  type EngineStatus,
} from "@deyin/host-core";
import {
  RoutineBridge,
  engineRoutineFor,
  engineSchedules,
  mirroredRun,
  mirroredRunId,
  reconcileBotRoutines,
  type EngineRoutinePort,
  type RoutineBridgeDeps,
} from "../src/main/bots/engine/routine-bridge.js";
import { makeBot } from "./helpers/bots.js";

function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: "auto_1",
    botId: "bot_1",
    name: "Morning digest",
    enabled: true,
    payload: { kind: "prompt", prompt: "Summarise my inbox." },
    trigger: { kind: "cron", expression: "0 8 * * *" },
    target: { kind: "local", workspacePath: "/x" },
    model: "glm-5.2",
    providerId: "openference",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const context = (over: Partial<Parameters<typeof engineRoutineFor>[1]> = {}) => ({
  bot: makeBot(),
  permissions: EMPTY_PERMISSIONS,
  memory: [],
  customProvider: false,
  ...over,
});

function routine(over: Partial<EngineRoutine> = {}): EngineRoutine {
  return { id: "auto_1", name: "Morning digest", cron: "0 8 * * *", prompt: "p", model: "glm-5.2", mode: "read_only", enabled: true, ...over };
}

function record(over: Partial<EngineRunRecord> = {}): EngineRunRecord {
  return { id: "r1", routineId: "auto_1", startedAt: 100, status: "completed", trigger: "schedule", ...over };
}

/* engineSchedules ---------------------------------------------------------- */

test("the engine schedules a routine only when it has a schedule and a prompt, on a Bot on a server that has an engine", () => {
  const bot = makeBot();
  assert.equal(engineSchedules(automation(), bot, true), true);
  assert.equal(engineSchedules(automation(), bot, false), false, "no engine on that server");
  assert.equal(engineSchedules(automation(), undefined, true), false, "no Bot");
  assert.equal(engineSchedules(automation({ botId: undefined }), bot, true), false, "not a Bot's routine");
  assert.equal(engineSchedules(automation(), makeBot({ harness: "local", hostId: undefined }), true), false, "a Bot on this computer");
  assert.equal(engineSchedules(automation(), makeBot({ hostId: undefined }), true), false, "a server Bot with no server");
  assert.equal(engineSchedules(automation({ trigger: { kind: "once", at: 5 } }), bot, true), false);
  assert.equal(engineSchedules(automation({ trigger: { kind: "manual" } }), bot, true), false);
  assert.equal(engineSchedules(automation({ payload: { kind: "skill", skill: "x" } }), bot, true), false);
  assert.equal(engineSchedules(automation({ payload: { kind: "subagent", subagent: "x" } }), bot, true), false);
});

/* engineRoutineFor --------------------------------------------------------- */

test("a routine becomes what the engine keeps: its schedule, model, mode, switch and a prompt that carries everything a server lacks", () => {
  const decision = engineRoutineFor(automation({ limits: { maxMinutes: 5 } }), context({ memory: [{ title: "Boss", description: "", body: "Grace" }] }));
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  const { routine: kept } = decision;
  assert.equal(kept.id, "auto_1");
  assert.equal(kept.name, "Morning digest");
  assert.equal(kept.cron, "0 8 * * *");
  assert.equal(kept.model, "glm-5.2");
  assert.equal(kept.mode, "read_only");
  assert.equal(kept.enabled, true);
  assert.equal(kept.timeoutMs, 300_000);
  assert.match(kept.prompt, /^<bot_identity>\nYou are Ada/);
  assert.match(kept.prompt, /You cannot save new memories/);
  assert.match(kept.prompt, /- Boss\n {2}Grace/);
  assert.match(kept.prompt, /Your routine "Morning digest" is running on its schedule\. Nobody is chatting with you now/);
  assert.ok(kept.prompt.endsWith("Summarise my inbox."));
});

test("a paused routine is kept paused, and a Bot that runs everything gives the routine the same", () => {
  const paused = engineRoutineFor(automation({ enabled: false }), context());
  assert.ok(paused.ok && paused.routine.enabled === false);
  const everything = engineRoutineFor(automation(), context({ bot: makeBot({ autoReview: { approvalMode: "run_everything" } }) }));
  assert.ok(everything.ok && everything.routine.mode === "run_everything");
  const review = engineRoutineFor(automation(), context({ bot: makeBot({ autoReview: { approvalMode: "auto_review" } }) }));
  assert.ok(review.ok && review.routine.mode === "read_only");
});

test("no time limit is sent when the routine has none, and the longest allowed is the most that is", () => {
  const none = engineRoutineFor(automation(), context());
  assert.ok(none.ok && !("timeoutMs" in none.routine));
  const zero = engineRoutineFor(automation({ limits: { maxMinutes: 0 } }), context());
  assert.ok(zero.ok && !("timeoutMs" in zero.routine));
  const huge = engineRoutineFor(automation({ limits: { maxMinutes: 100_000 } }), context());
  assert.ok(huge.ok && huge.routine.timeoutMs === RUNTIME_LIMITS.runTimeoutMaxMs);
});

test("the routine's name is one line, clipped, and never empty", () => {
  const long = engineRoutineFor(automation({ name: `Line one\n  line two ${"x".repeat(200)}` }), context());
  assert.ok(long.ok);
  if (long.ok) {
    assert.ok(long.routine.name.startsWith("Line one line two "));
    assert.ok(long.routine.name.length <= 80);
  }
  const blank = engineRoutineFor(automation({ name: "  \n " }), context());
  assert.ok(blank.ok && blank.routine.name === "Routine");
});

test("what a server cannot keep is said in words, not guessed at", () => {
  const reason = (decision: ReturnType<typeof engineRoutineFor>): string => (decision.ok ? assert.fail("expected a refusal") : decision.reason);
  assert.match(reason(engineRoutineFor(automation({ botId: "other" }), context())), /belongs to another Bot/);
  assert.match(reason(engineRoutineFor(automation({ trigger: { kind: "manual" } }), context())), /Only a routine with a schedule/);
  assert.match(reason(engineRoutineFor(automation({ payload: { kind: "skill", skill: "x" } }), context())), /skill or a subagent runs only on this computer/);
  assert.match(reason(engineRoutineFor(automation(), context({ customProvider: true }))), /only use models served by Openference/);
  assert.match(reason(engineRoutineFor(automation({ id: "has space" }), context())), /id cannot be kept on a server/);
  assert.match(reason(engineRoutineFor(automation({ model: "two words" }), context())), /model cannot contain spaces/);
  assert.match(reason(engineRoutineFor(automation({ trigger: { kind: "cron", expression: "0 8 *\n* *" } }), context())), /schedule has a character/);
  assert.match(
    reason(engineRoutineFor(automation({ payload: { kind: "prompt", prompt: "x".repeat(RUNTIME_LIMITS.promptLength) } }), context())),
    /too long to send to a Bot on a server/,
  );
  const blocked: BotPermissionSettings = { ...EMPTY_PERMISSIONS, scopes: { local: { tools: { shell: "blocked" } } } };
  assert.match(
    reason(engineRoutineFor(automation(), context({ bot: makeBot({ autoReview: { approvalMode: "run_everything" } }), permissions: blocked }))),
    /blocked or set to ask first/,
  );
});

/* mirroredRun -------------------------------------------------------------- */

test("a run the engine did is a run in the app's history, under an id that cannot clash with the app's own", () => {
  assert.equal(mirroredRunId({ id: "r1" }), "engine-r1");
  assert.deepEqual(mirroredRun("auto_1", record({ finishedAt: 200, finalText: "Done." })), {
    id: "engine-r1",
    automationId: "auto_1",
    status: "completed",
    startedAt: 100,
    finishedAt: 200,
    finalText: "Done.",
    events: [],
  });
});

test("every way the engine's run can end has a status and a reason in words", () => {
  const status = (over: Partial<EngineRunRecord>): Pick<AutomationRun, "status" | "reason"> => {
    const run = mirroredRun("auto_1", record(over));
    return { status: run.status, reason: run.reason };
  };
  assert.deepEqual(status({ status: "running" }), { status: "running", reason: undefined });
  assert.deepEqual(status({ status: "failed", reason: "no credit" }), { status: "failed", reason: "no credit" });
  assert.deepEqual(status({ status: "aborted", reason: "stopped" }), { status: "aborted", reason: "stopped" });
  assert.deepEqual(status({ status: "timeout" }), { status: "failed", reason: "The run took too long and was stopped." });
  assert.deepEqual(status({ status: "timeout", reason: "30 minutes" }), { status: "failed", reason: "30 minutes" });
  assert.deepEqual(status({ status: "skipped" }), { status: "aborted", reason: "skipped: the previous run was still going" });
  assert.deepEqual(status({ status: "skipped", reason: "paused" }), { status: "aborted", reason: "skipped: paused" });
  const unfinished = mirroredRun("auto_1", record({ status: "running" }));
  assert.ok(!("finishedAt" in unfinished) && !("finalText" in unfinished));
});

/* reconcileBotRoutines ----------------------------------------------------- */

class FakeEngine implements EngineRoutinePort {
  readonly calls: string[] = [];
  routinesByBot = new Map<string, Map<string, EngineRoutineView>>();
  runsByRoutine = new Map<string, EngineRunRecord[]>();
  failWith: Error | null = null;
  failSaveFor: string | null = null;
  botsOnStatus: EngineStatus["bots"] = [];

  seed(botId: string, ...routines: EngineRoutine[]): void {
    const map = this.routinesByBot.get(botId) ?? new Map();
    for (const one of routines) map.set(one.id, one);
    this.routinesByBot.set(botId, map);
  }
  ids(botId: string): string[] {
    return [...(this.routinesByBot.get(botId)?.keys() ?? [])];
  }
  async status(): Promise<EngineStatus> {
    this.calls.push("status");
    if (this.failWith) throw this.failWith;
    return {
      apiVersion: 1,
      version: "1.0.0",
      startedAt: 1,
      agent: { found: true, signedIn: true },
      bots: this.botsOnStatus.length > 0 ? this.botsOnStatus : [...this.routinesByBot].map(([botId, map]) => ({ botId, routines: map.size, running: 0 })),
      runningNow: 0,
    };
  }
  async routines(botId: string): Promise<EngineRoutineView[]> {
    this.calls.push(`list ${botId}`);
    if (this.failWith) throw this.failWith;
    return [...(this.routinesByBot.get(botId)?.values() ?? [])];
  }
  async saveRoutine(botId: string, one: EngineRoutine): Promise<EngineRoutineView> {
    this.calls.push(`save ${botId} ${one.id}`);
    if (this.failSaveFor === one.id) throw new Error(`the engine refused ${one.id}`);
    this.seed(botId, one);
    return one;
  }
  async removeRoutine(botId: string, routineId: string): Promise<boolean> {
    this.calls.push(`remove ${botId} ${routineId}`);
    return this.routinesByBot.get(botId)?.delete(routineId) ?? false;
  }
  async routineRuns(_botId: string, routineId: string): Promise<EngineRunRecord[]> {
    this.calls.push(`runs ${routineId}`);
    return this.runsByRoutine.get(routineId) ?? [];
  }
}

test("a Bot's routines on the server are made to match: missing and changed ones saved, extras removed, matching ones left alone", async () => {
  const engine = new FakeEngine();
  engine.seed("bot_1", routine({ id: "same" }), routine({ id: "changed", cron: "0 9 * * *" }), routine({ id: "extra" }));
  const result = await reconcileBotRoutines(engine, "bot_1", [routine({ id: "same" }), routine({ id: "changed" }), routine({ id: "new" })]);
  assert.deepEqual(result, { saved: ["changed", "new"], removed: ["extra"] });
  assert.deepEqual(engine.calls, ["list bot_1", "save bot_1 changed", "save bot_1 new", "remove bot_1 extra"], "wanted routines are saved before unwanted ones are removed");
  assert.deepEqual(engine.ids("bot_1").sort(), ["changed", "new", "same"]);
});

test("each field of a routine counts as a difference", async () => {
  const fields: Array<Partial<EngineRoutine>> = [
    { name: "other" },
    { cron: "1 1 * * *" },
    { prompt: "other" },
    { model: "other" },
    { mode: "run_everything" },
    { enabled: false },
    { timeoutMs: 60_000 },
  ];
  for (const change of fields) {
    const engine = new FakeEngine();
    engine.seed("bot_1", routine());
    const result = await reconcileBotRoutines(engine, "bot_1", [routine(change)]);
    assert.deepEqual(result.saved, ["auto_1"], `a different ${Object.keys(change)[0]} is saved`);
  }
  const engine = new FakeEngine();
  engine.seed("bot_1", routine({ timeoutMs: 60_000 }));
  assert.deepEqual((await reconcileBotRoutines(engine, "bot_1", [routine()])).saved, ["auto_1"], "a time limit taken away is saved");
});

test("a failure part way is thrown, leaving what was done as it is", async () => {
  const engine = new FakeEngine();
  engine.failSaveFor = "b";
  await assert.rejects(() => reconcileBotRoutines(engine, "bot_1", [routine({ id: "a" }), routine({ id: "b" }), routine({ id: "c" })]), /the engine refused b/);
  assert.deepEqual(engine.ids("bot_1"), ["a"]);
});

/* RoutineBridge ------------------------------------------------------------ */

function bridgeRig(options: { bots?: DeyinBot[]; automations?: Automation[]; hosts?: string[]; engines?: Record<string, FakeEngine>; debounceMs?: number } = {}) {
  const bots = options.bots ?? [makeBot()];
  const state = { automations: options.automations ?? [automation()], hosts: options.hosts ?? ["host_1"], bots, custom: new Set<string>(), memory: [] as Array<{ title: string; description: string; body: string }>, skills: new Map<string, Array<{ name: string; description: string; body: string }>>(), skillFailure: null as Error | null };
  const engines = options.engines ?? { host_1: new FakeEngine() };
  const mirrored: AutomationRun[] = [];
  const seen = new Set<string>();
  const changes: number[] = [];
  const deps: RoutineBridgeDeps = {
    automations: { list: () => state.automations },
    bots: {
      get: (id) => state.bots.find((bot) => bot.id === id),
      list: () => state.bots,
    },
    permissions: { get: () => EMPTY_PERMISSIONS },
    memoryOf: () => state.memory,
    skillsOf: async (bot) => {
      if (state.skillFailure) throw state.skillFailure;
      return state.skills.get(bot.id) ?? [];
    },
    isCustomProvider: (id) => state.custom.has(id),
    engines: {
      hostIds: () => state.hosts,
      port: async (hostId) => {
        const engine = engines[hostId];
        if (!engine) throw new BotError("conflict", `Could not connect to ${hostId}`);
        return engine;
      },
    },
    runs: {
      mirror: (run) => {
        if (seen.has(run.id)) return false;
        seen.add(run.id);
        mirrored.push(run);
        return true;
      },
    },
    onChange: () => changes.push(Date.now()),
    debounceMs: options.debounceMs ?? 5,
  };
  return { bridge: new RoutineBridge(deps), state, engines, mirrored, changes, engine: engines["host_1"]! };
}

test("a pass puts a Bot's scheduled routines on its server and says so", async () => {
  const { bridge, engine, changes } = bridgeRig();
  const report = await bridge.syncAll();
  assert.deepEqual(report, { saved: 1, removed: 0, mirrored: 0, errors: [] });
  assert.deepEqual(engine.ids("bot_1"), ["auto_1"]);
  assert.deepEqual(bridge.stateOf("auto_1"), { state: "server", hostId: "host_1" });
  assert.equal(changes.length, 1, "the app is told to refresh");
  assert.equal(bridge.stateOf("nope"), undefined);
});

test("a second pass changes nothing", async () => {
  const { bridge, engine } = bridgeRig();
  await bridge.syncAll();
  const before = engine.calls.filter((call) => call.startsWith("save")).length;
  const report = await bridge.syncAll();
  assert.deepEqual([report.saved, report.removed], [0, 0]);
  assert.equal(engine.calls.filter((call) => call.startsWith("save")).length, before);
});

test("a routine the server cannot keep is shown as blocked with the reason, and is not put there", async () => {
  const { bridge, engine, state } = bridgeRig();
  state.custom.add("openference");
  await bridge.syncAll();
  assert.deepEqual(engine.ids("bot_1"), []);
  const blocked = bridge.stateOf("auto_1");
  assert.equal(blocked?.state, "blocked");
  assert.match(blocked?.state === "blocked" ? blocked.reason : "", /served by Openference/);
});

test("a routine that is blocked later is taken off the server", async () => {
  const { bridge, engine, state } = bridgeRig();
  await bridge.syncAll();
  assert.deepEqual(engine.ids("bot_1"), ["auto_1"]);
  state.custom.add("openference");
  const report = await bridge.syncAll();
  assert.equal(report.removed, 1);
  assert.deepEqual(engine.ids("bot_1"), []);
});

test("routines the app starts itself are not put on the server and have no server state", async () => {
  const { bridge, engine } = bridgeRig({
    automations: [
      automation({ id: "manual", trigger: { kind: "manual" } }),
      automation({ id: "skill", payload: { kind: "skill", skill: "x" } }),
      automation({ id: "plain", botId: undefined }),
      automation({ id: "local_bot", botId: "bot_local" }),
    ],
    bots: [makeBot(), makeBot({ id: "bot_local", harness: "local", hostId: undefined, handle: "local" })],
  });
  await bridge.syncAll();
  assert.deepEqual(engine.ids("bot_1"), []);
  for (const id of ["manual", "skill", "plain", "local_bot"]) assert.equal(bridge.stateOf(id), undefined, id);
  assert.equal(bridge.schedulesOnServer(automation({ id: "manual", trigger: { kind: "manual" } })), false);
});

test("whether the engine schedules a routine follows the Bot's server having an engine", async () => {
  const rig = bridgeRig();
  assert.equal(rig.bridge.schedulesOnServer(automation()), true);
  rig.state.hosts = [];
  assert.equal(rig.bridge.schedulesOnServer(automation()), false, "without an engine on the server the app keeps it");
  rig.state.hosts = ["host_1"];
  assert.equal(rig.bridge.schedulesOnServer(automation({ botId: "ghost" })), false, "an unknown Bot");
  rig.state.bots[0] = makeBot({ archived: true });
  assert.equal(rig.bridge.schedulesOnServer(automation()), false, "an archived Bot's routines do not run");
});

test("when the server cannot be reached its routines wait, with the reason, and the next pass tries again", async () => {
  const { bridge, engine } = bridgeRig();
  engine.failWith = new Error("connection reset");
  const report = await bridge.syncAll();
  assert.deepEqual(report.errors, [{ hostId: "host_1", message: "connection reset" }]);
  assert.deepEqual(bridge.stateOf("auto_1"), { state: "waiting", hostId: "host_1", reason: "connection reset" });
  engine.failWith = null;
  await bridge.syncAll();
  assert.deepEqual(bridge.stateOf("auto_1"), { state: "server", hostId: "host_1" });
});

test("a server with no way in leaves the other servers' routines alone", async () => {
  const other = new FakeEngine();
  const { bridge, state } = bridgeRig({
    bots: [makeBot(), makeBot({ id: "bot_2", handle: "bo", hostId: "host_2" })],
    automations: [automation(), automation({ id: "auto_2", botId: "bot_2" })],
    hosts: ["host_1", "host_2"],
    engines: { host_2: other },
  });
  void state;
  const report = await bridge.syncAll();
  assert.equal(report.errors.length, 1);
  assert.equal(bridge.stateOf("auto_1")?.state, "waiting");
  assert.equal(bridge.stateOf("auto_2")?.state, "server");
  assert.deepEqual(other.ids("bot_2"), ["auto_2"]);
});

test("one routine the engine refuses does not stop the Bot's others being tried on the next pass, and it waits", async () => {
  const { bridge, engine } = bridgeRig({ automations: [automation({ id: "a" }), automation({ id: "b" })] });
  engine.failSaveFor = "b";
  const report = await bridge.syncAll();
  assert.equal(report.errors.length, 1);
  assert.equal(bridge.stateOf("a")?.state, "waiting", "a Bot is reconciled as a whole, so its routines wait together");
  assert.equal(bridge.stateOf("b")?.state, "waiting");
  engine.failSaveFor = null;
  await bridge.syncAll();
  assert.equal(bridge.stateOf("a")?.state, "server");
  assert.equal(bridge.stateOf("b")?.state, "server");
});

test("a Bot that moved to another server, or was archived, has its routines taken off the old server", async () => {
  const { bridge, engine, state } = bridgeRig();
  await bridge.syncAll();
  state.bots[0] = makeBot({ harness: "local", hostId: undefined });
  const moved = await bridge.syncAll();
  assert.equal(moved.removed, 1);
  assert.deepEqual(engine.ids("bot_1"), []);
  assert.equal(bridge.stateOf("auto_1"), undefined);

  state.bots[0] = makeBot();
  await bridge.syncAll();
  assert.deepEqual(engine.ids("bot_1"), ["auto_1"]);
  state.bots[0] = makeBot({ archived: true });
  const archived = await bridge.syncAll();
  assert.equal(archived.removed, 1, "an archived Bot's routines do not run on the server");
  assert.deepEqual(engine.ids("bot_1"), []);
});

test("routines on the server of a Bot this app does not know belong to another computer and are left alone", async () => {
  const { bridge, engine } = bridgeRig();
  engine.seed("stranger", routine({ id: "theirs" }));
  const report = await bridge.syncAll();
  assert.equal(report.removed, 0);
  assert.deepEqual(engine.ids("stranger"), ["theirs"]);
});

test("runs the engine did are brought into the app's history once each", async () => {
  const { bridge, engine, mirrored } = bridgeRig();
  engine.runsByRoutine.set("auto_1", [record({ id: "r1" }), record({ id: "r2", status: "failed", reason: "boom", finishedAt: 300 })]);
  assert.equal((await bridge.syncAll()).mirrored, 2);
  assert.deepEqual(mirrored.map((run) => [run.id, run.status]), [["engine-r1", "completed"], ["engine-r2", "failed"]]);
  assert.equal((await bridge.syncAll()).mirrored, 0, "the second pass finds them already there");
});

test("the Bot's memory is read only when a routine is going to the server, and a changed memory updates the routine", async () => {
  let reads = 0;
  const rig = bridgeRig();
  const original = rig.state.memory;
  void original;
  const deps = (rig.bridge as unknown as { deps: RoutineBridgeDeps }).deps;
  const memoryOf = deps.memoryOf;
  deps.memoryOf = (bot) => {
    reads += 1;
    return memoryOf(bot);
  };
  await rig.bridge.syncAll();
  assert.equal(reads, 1);
  rig.state.memory = [{ title: "Boss", description: "", body: "Grace" }];
  const report = await rig.bridge.syncAll();
  assert.equal(report.saved, 1, "the routine is saved again with the new memory in its prompt");
  assert.match([...rig.engine.routinesByBot.get("bot_1")!.values()][0]!.prompt, /Grace/);

  const idle = bridgeRig({ automations: [] });
  const idleDeps = (idle.bridge as unknown as { deps: RoutineBridgeDeps }).deps;
  idleDeps.memoryOf = () => assert.fail("a Bot with nothing to send does not have its memory read");
  await idle.bridge.syncAll();
});

test("what a Bot has learned goes into the routine's prompt, and a changed skill updates the routine", async () => {
  const rig = bridgeRig();
  rig.state.skills.set("bot_1", [{ name: "weekly-report", description: "Write the weekly report", body: "1. Open the sheet\n2. Summarise it" }]);
  await rig.bridge.syncAll();
  const prompt = () => [...rig.engine.routinesByBot.get("bot_1")!.values()][0]!.prompt;
  assert.match(prompt(), /<bot_skills>[\s\S]*## weekly-report: Write the weekly report\n1\. Open the sheet[\s\S]*<\/bot_skills>/);
  assert.equal((await rig.bridge.syncAll()).saved, 0, "nothing changed, so nothing is saved");
  rig.state.skills.set("bot_1", [{ name: "weekly-report", description: "Write the weekly report", body: "1. Open the sheet\n2. Summarise it\n3. Send nothing" }]);
  assert.equal((await rig.bridge.syncAll()).saved, 1);
  assert.match(prompt(), /3\. Send nothing/);
  rig.state.skills.set("bot_1", []);
  assert.equal((await rig.bridge.syncAll()).saved, 1, "a skill taken away is taken out of the prompt");
  assert.doesNotMatch(prompt(), /bot_skills/);
});

test("the skills are read only for a Bot with a routine going to the server", async () => {
  const idle = bridgeRig({ automations: [] });
  const deps = (idle.bridge as unknown as { deps: RoutineBridgeDeps }).deps;
  deps.skillsOf = () => assert.fail("a Bot with nothing to send does not have its skills read");
  await idle.bridge.syncAll();
});

test("when a Bot's skills cannot be read its routines are left as they were and are tried again, and another Bot is not held up", async () => {
  const rig = bridgeRig({
    bots: [makeBot({ id: "bot_1" }), makeBot({ id: "bot_2", name: "Second" })],
    automations: [automation(), automation({ id: "auto_2", botId: "bot_2" })],
  });
  await rig.bridge.syncAll();
  const before = JSON.stringify([...rig.engine.routinesByBot.get("bot_1")!.values()]);
  const deps = (rig.bridge as unknown as { deps: RoutineBridgeDeps }).deps;
  deps.skillsOf = async (bot) => {
    if (bot.id === "bot_1") throw new Error("the disk said no");
    return [{ name: "second-skill", description: "Only the second Bot has it", body: "Do the second thing." }];
  };
  const report = await rig.bridge.syncAll();
  assert.deepEqual(report.errors, [{ hostId: "host_1", message: "the disk said no" }]);
  assert.equal(JSON.stringify([...rig.engine.routinesByBot.get("bot_1")!.values()]), before, "what the server has is not changed to something without the skills");
  assert.deepEqual(rig.bridge.stateOf("auto_1"), { state: "waiting", hostId: "host_1", reason: "the disk said no" });
  assert.deepEqual(rig.bridge.stateOf("auto_2"), { state: "server", hostId: "host_1" });
  assert.match([...rig.engine.routinesByBot.get("bot_2")!.values()][0]!.prompt, /second-skill/);
  deps.skillsOf = async () => [];
  assert.deepEqual((await rig.bridge.syncAll()).errors, []);
  assert.deepEqual(rig.bridge.stateOf("auto_1"), { state: "server", hostId: "host_1" });
});

test("passes run one at a time, and one asked for during another runs after it", async () => {
  const { bridge, engine } = bridgeRig();
  let running = 0;
  let overlapped = false;
  const original = engine.routines.bind(engine);
  engine.routines = async (botId) => {
    running += 1;
    if (running > 1) overlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const result = await original(botId);
    running -= 1;
    return result;
  };
  await Promise.all([bridge.syncAll(), bridge.syncAll(), bridge.syncAll()]);
  assert.equal(overlapped, false);
  assert.equal(engine.calls.filter((call) => call === "list bot_1").length, 3);
});

test("a pass that throws does not stop the next one", async () => {
  const { bridge, state } = bridgeRig();
  const broken = state.bots;
  Object.defineProperty(state, "bots", { get: () => broken, configurable: true });
  const deps = (bridge as unknown as { deps: RoutineBridgeDeps }).deps;
  const list = deps.automations.list;
  let first = true;
  deps.automations.list = () => {
    if (first) {
      first = false;
      throw new Error("store is broken");
    }
    return list();
  };
  await assert.rejects(() => bridge.syncAll(), /store is broken/);
  assert.equal((await bridge.syncAll()).saved, 1);
});

test("a burst of changes becomes one pass, and nothing happens after dispose", async () => {
  const rig = bridgeRig({ debounceMs: 20 });
  rig.bridge.schedule();
  rig.bridge.schedule();
  rig.bridge.schedule();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(rig.engine.calls.filter((call) => call === "list bot_1").length, 1);

  const stopped = bridgeRig({ debounceMs: 10 });
  stopped.bridge.schedule();
  stopped.bridge.dispose();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stopped.engine.calls.length, 0);
  stopped.bridge.schedule();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stopped.engine.calls.length, 0, "a disposed bridge does not start again");
});
