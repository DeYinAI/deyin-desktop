import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotSkillStore, BotStore, FileStorage, type Automation, type AutomationInfo, type AutomationRun } from "@deyin/host-core";
import type { ToolDefinition } from "@deyin/agent-core";
import { createBotTools, type RoutineAccess } from "../src/main/bots/bot-tools.js";

const dirs: string[] = [];
const storages: FileStorage[] = [];
after(async () => {
  await Promise.all(storages.map((storage) => storage.flush()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type NewAutomation = Omit<Automation, "id" | "createdAt" | "updatedAt">;

/** The routine service, kept in memory. It keeps what the tools sent, so a test can see exactly that. */
function fakeRoutines(seed: AutomationInfo[] = []) {
  let list = [...seed];
  const sent: { created: NewAutomation[]; patches: Array<{ id: string; patch: Partial<Automation> }>; removed: string[]; ran: string[] } = { created: [], patches: [], removed: [], ran: [] };
  const service: RoutineAccess = {
    list: () => list,
    create(input) {
      sent.created.push(input);
      const automation: AutomationInfo = { ...input, id: `auto_${list.length + 1}`, createdAt: 1, updatedAt: 1 };
      list = [...list, automation];
      return { automation, list };
    },
    update(id, patch) {
      sent.patches.push({ id, patch });
      list = list.map((a) => (a.id === id ? { ...a, ...patch } : a));
      return { automation: list.find((a) => a.id === id)!, list };
    },
    remove(id) {
      sent.removed.push(id);
      list = list.filter((a) => a.id !== id);
      return list;
    },
    run(id) {
      sent.ran.push(id);
      return { id: "run_1", automationId: id, status: "running", startedAt: 1, events: [] } satisfies AutomationRun;
    },
    listRuns: () => [],
  };
  return { service, sent };
}

function routine(over: Partial<AutomationInfo> & Pick<AutomationInfo, "id" | "name">): AutomationInfo {
  return {
    enabled: true,
    payload: { kind: "prompt", prompt: "Summarise my inbox." },
    trigger: { kind: "cron", expression: "0 8 * * *" },
    target: { kind: "local", workspacePath: "/bots/x/files" },
    model: "m",
    providerId: "p",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function setup(options: { routines?: ReturnType<typeof fakeRoutines>; waited?: Array<[string, string, number]> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deyin-bottools-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const me = store.create({ name: "Bill" });
  store.setPrimary(me.id);
  const skills = new BotSkillStore(join(dir, "skills"));
  const tools = createBotTools({
    botId: me.id,
    store,
    skills,
    ...(options.routines ? { routines: options.routines.service } : {}),
    model: { model: "gpt-x", providerId: "openference" },
    wait: async (automationId, runId, timeoutMs) => {
      options.waited?.push([automationId, runId, timeoutMs]);
      return `Run ${runId} completed.`;
    },
  });
  const tool = (name: string): ToolDefinition => {
    const found = tools.find((t) => t.name === name);
    assert.ok(found, `${name} is registered`);
    return found;
  };
  const call = (name: string, args: Record<string, unknown> = {}) => tool(name).execute(args, {} as never);
  return { dir, store, me, skills, tools, tool, call };
}

test("without the routine service there are no routine tools, and the rest are still there", () => {
  const { tools } = setup();
  assert.deepEqual(tools.map((t) => t.name), ["bot_list", "bot_create", "skill_save"]);
});

test("with it, a Bot has the routine tools beside them", () => {
  const { tools } = setup({ routines: fakeRoutines() });
  assert.deepEqual(tools.map((t) => t.name), [
    "bot_list",
    "bot_create",
    "skill_save",
    "routine_list",
    "routine_create",
    "routine_update",
    "routine_delete",
    "routine_run",
  ]);
});

test("looking is free; changing things is not: listing is read, the rest ask, and running is the heaviest", () => {
  const { tool } = setup({ routines: fakeRoutines() });
  const tiers = Object.fromEntries(["bot_list", "bot_create", "skill_save", "routine_list", "routine_create", "routine_update", "routine_delete", "routine_run"].map((n) => [n, tool(n).tier]));
  assert.deepEqual(tiers, {
    bot_list: "read",
    bot_create: "write",
    skill_save: "write",
    routine_list: "read",
    routine_create: "write",
    routine_update: "write",
    routine_delete: "write",
    routine_run: "execute",
  });
});

test("bot_list shows each Bot by handle, marks the primary and the Bot that is asking, and counts its routines", async () => {
  const routines = fakeRoutines();
  const { call, store, me } = setup({ routines });
  const ada = store.create({ name: "Ada", title: "Researcher", purpose: "Find sources.\nCite them." });
  routines.service.create({ botId: ada.id, name: "n", enabled: true, payload: { kind: "prompt", prompt: "p" }, trigger: { kind: "manual" }, target: { kind: "local", workspacePath: "" }, model: "m", providerId: "p" });
  const text = await call("bot_list");
  assert.match(text, new RegExp(`^- @${me.handle}: Bill \\(primary; you\\)\\. 0 routines\\.$`, "m"));
  assert.match(text, /^- @ada: Ada, Researcher\. Find sources\. Cite them\. 1 routine\.$/m);
});

test("bot_list names a room's members and leaves archived Bots out", async () => {
  const { call, store, me } = setup();
  const ada = store.create({ name: "Ada" });
  const old = store.create({ name: "Old" });
  store.create({ name: "Standup", kind: "room", memberBotIds: [me.id, ada.id] });
  store.archive(old.id);
  const text = await call("bot_list");
  assert.match(text, /room with @bill, @ada/);
  assert.doesNotMatch(text, /@old/);
});

test("bot_create makes a Bot with the job as its standing instructions, and tells the Bot what to say", async () => {
  const { call, store } = setup();
  const text = await call("bot_create", { name: "Standup Scribe", job: "Write up the standup each morning. Ask me before posting.", title: "Meeting notes" });
  const made = store.list().find((bot) => bot.name === "Standup Scribe");
  assert.ok(made);
  assert.equal(made.purpose, "Write up the standup each morning. Ask me before posting.");
  assert.equal(made.title, "Meeting notes");
  assert.equal(made.harness, "local");
  assert.equal(made.autoReview.approvalMode, "auto_review", "a new Bot gets the default permissions, nothing more");
  assert.equal(made.isPrimary, false);
  assert.match(text, new RegExp(`Created Standup Scribe \\(@${made.handle}\\)`));
  assert.match(text, /next message/);
});

test("bot_create will not make a Bot with no name or no job, and cannot be talked into a server or a room", async () => {
  const { call, store } = setup();
  const before = store.list().length;
  await assert.rejects(call("bot_create", { name: "", job: "x" }), /Give the Bot a name/);
  await assert.rejects(call("bot_create", { name: "Ada", job: "  " }), /what the Bot is for/);
  await call("bot_create", { name: "Sneaky", job: "x", harness: "server", hostId: "h1", kind: "room", approvalMode: "run_everything", isPrimary: true });
  const made = store.list().find((bot) => bot.name === "Sneaky")!;
  assert.deepEqual([made.harness, made.kind, made.autoReview.approvalMode, made.isPrimary], ["local", "agent", "auto_review", false]);
  assert.equal(store.list().length, before + 1);
});

test("skill_save writes a skill as the Bot's own, and saving it again keeps the version history", async () => {
  const { call, skills } = setup();
  const first = await call("skill_save", { name: "weekly-report", description: "Write the weekly report", body: "1. Open the sheet.\n2. Summarise it." });
  assert.match(first, /Saved the skill "weekly-report" \(version 1\)/);
  const second = await call("skill_save", { name: "weekly-report", description: "Write the weekly report", body: "1. Open the sheet.\n2. Summarise it in five lines." });
  assert.match(second, /version 2/);
  const revisions = await skills.revisions("weekly-report");
  assert.deepEqual(revisions.map((r) => r.author), ["bot", "bot"]);
  assert.equal((await skills.get("weekly-report")).origin, "bot");
});

test("skill_save says what to change when the skill is not valid", async () => {
  const { call } = setup();
  await assert.rejects(call("skill_save", { name: "Weekly Report!", description: "d", body: "b" }), /lowercase letters and numbers with hyphens/);
  await assert.rejects(call("skill_save", { name: "ok", description: "", body: "b" }), /Say in a sentence what the skill is for/);
  await assert.rejects(call("skill_save", { name: "ok", description: "d", body: "" }), /needs instructions/);
});

test("routine_create sends the Bot's own id, a prompt, this chat's model, and a schedule, and never a folder", async () => {
  const routines = fakeRoutines();
  const { call, me } = setup({ routines });
  const text = await call("routine_create", { name: "Morning brief", instruction: "Read my inbox and send me the three that matter.", cron: "0 8 * * 1-5" });
  assert.equal(routines.sent.created.length, 1);
  const sent = routines.sent.created[0]!;
  assert.equal(sent.botId, me.id);
  assert.equal(sent.name, "Morning brief");
  assert.deepEqual(sent.payload, { kind: "prompt", prompt: "Read my inbox and send me the three that matter." });
  assert.deepEqual(sent.trigger, { kind: "cron", expression: "0 8 * * 1-5" });
  assert.deepEqual([sent.model, sent.providerId, sent.enabled], ["gpt-x", "openference", true]);
  assert.equal(sent.target.workspacePath, "", "the host pins the Bot's own folder; the tool names none");
  assert.match(text, /Created the routine "Morning brief" \(id auto_1\)\. It will run cron 0 8 \* \* 1-5, and its result will be posted to this conversation\./);
});

test("a routine with no schedule is manual, and the Bot is told how to run it or schedule it", async () => {
  const routines = fakeRoutines();
  const { call } = setup({ routines });
  const text = await call("routine_create", { name: "On demand", instruction: "Do the thing." });
  assert.deepEqual(routines.sent.created[0]!.trigger, { kind: "manual" });
  assert.match(text, /only runs when asked/);
  assert.match(text, /routine_run/);
});

test("routine_create refuses what has no name, no instruction, a past time, or no model", async () => {
  const routines = fakeRoutines();
  const { call } = setup({ routines });
  await assert.rejects(call("routine_create", { name: "", instruction: "x" }), /short name/);
  await assert.rejects(call("routine_create", { name: "n", instruction: "" }), /what the routine should do/);
  await assert.rejects(call("routine_create", { name: "n", instruction: "x", runAt: "2001-01-01T00:00:00Z" }), /must be in the future/);
  await assert.rejects(call("routine_create", { name: "n", instruction: "x", runAt: "tomorrow-ish" }), /not a valid ISO 8601/);
  assert.equal(routines.sent.created.length, 0, "nothing was created by any of them");
});

test("routine_create without a selected model says so instead of making a routine that cannot run", async () => {
  const routines = fakeRoutines();
  const dir = mkdtempSync(join(tmpdir(), "deyin-bottools-"));
  dirs.push(dir);
  const storage = new FileStorage(dir);
  storages.push(storage);
  const store = new BotStore(storage);
  const me = store.create({ name: "Bill" });
  const tools = createBotTools({ botId: me.id, store, skills: new BotSkillStore(join(dir, "skills")), routines: routines.service, model: { model: "", providerId: "" } });
  const create = tools.find((t) => t.name === "routine_create")!;
  await assert.rejects(create.execute({ name: "n", instruction: "x" }, {} as never), /No model is selected/);
  assert.equal(routines.sent.created.length, 0);
});

test("routine_list shows only this Bot's routines, with the start of what the last run said", async () => {
  const base = setup();
  const routines = fakeRoutines([
    routine({ id: "r_mine", name: "Morning brief", botId: base.me.id, nextRunAt: Date.UTC(2030, 0, 2, 8), lastRun: { id: "x", automationId: "r_mine", status: "completed", startedAt: Date.UTC(2030, 0, 1, 8), finalText: "Three emails matter:\n1. Rent.", events: [] } }),
    routine({ id: "r_other", name: "Someone else's", botId: "bot_other" }),
    routine({ id: "r_plain", name: "Not a routine", botId: undefined }),
  ]);
  const tools = createBotTools({ botId: base.me.id, store: base.store, skills: base.skills, routines: routines.service, model: { model: "m", providerId: "p" } });
  const text = await tools.find((t) => t.name === "routine_list")!.execute({}, {} as never);
  assert.match(text, /Morning brief \(id r_mine\): cron 0 8 \* \* \*, next run 2030-01-02T08:00:00\.000Z\./);
  assert.match(text, /Last run completed, 2030-01-01T08:00:00\.000Z: Three emails matter: 1\. Rent\./);
  assert.doesNotMatch(text, /Someone else's|Not a routine/);
});

test("routine_list says so when there are none", async () => {
  const { call } = setup({ routines: fakeRoutines() });
  assert.equal(await call("routine_list"), "You have no routines yet.");
});

/** A Bot with two routines of its own and one that is another Bot's, to test finding and not finding. */
function withRoutines() {
  const base = setup();
  const routines = fakeRoutines([
    routine({ id: "abcd1234", name: "Morning brief", botId: base.me.id }),
    routine({ id: "abcd5678", name: "Evening wrap", botId: base.me.id }),
    routine({ id: "zzzz0000", name: "Not mine", botId: "bot_other" }),
  ]);
  const waited: Array<[string, string, number]> = [];
  const tools = createBotTools({ botId: base.me.id, store: base.store, skills: base.skills, routines: routines.service, model: { model: "m", providerId: "p" }, wait: async (a, r, t) => (waited.push([a, r, t]), "waited") });
  const call = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.execute(args, {} as never);
  return { routines, call, waited };
}

test("a routine is found by name (any case), by id, or by a unique start of its id", async () => {
  const { call, routines } = withRoutines();
  await call("routine_delete", { routine: "morning BRIEF" });
  await call("routine_delete", { routine: "abcd5678" });
  assert.deepEqual(routines.sent.removed, ["abcd1234", "abcd5678"]);
  const second = withRoutines();
  await second.call("routine_delete", { routine: "abcd5" });
  assert.deepEqual(second.routines.sent.removed, ["abcd5678"]);
});

test("a start of an id that fits two routines, or too short a start, or another Bot's routine, is not found", async () => {
  const { call, routines } = withRoutines();
  await assert.rejects(call("routine_delete", { routine: "abcd" }), /fits 2 routines/);
  await assert.rejects(call("routine_delete", { routine: "abc" }), /no routine called "abc"/);
  await assert.rejects(call("routine_delete", { routine: "Not mine" }), /no routine called "Not mine"/);
  await assert.rejects(call("routine_delete", { routine: "zzzz0000" }), /no routine called "zzzz0000"/);
  await assert.rejects(call("routine_delete", { routine: "" }), /Say which routine/);
  assert.deepEqual(routines.sent.removed, [], "nothing was removed by any of them");
});

test("routine_update changes only what was passed, can pause, and cannot move a routine or give it a folder", async () => {
  const { call, routines } = withRoutines();
  const text = await call("routine_update", { routine: "Morning brief", enable: false, name: "Brief", botId: "bot_other", workspacePath: "/etc", model: "other" });
  assert.deepEqual(routines.sent.patches, [{ id: "abcd1234", patch: { name: "Brief", enabled: false } }]);
  assert.match(text, /^Updated\. Now: Brief \(id abcd1234\): cron 0 8 \* \* \*, paused\./);
});

test("routine_update rewrites the instruction whole and can change the schedule, including to manual", async () => {
  const { call, routines } = withRoutines();
  await call("routine_update", { routine: "abcd1234", instruction: "New words.", cron: "30 7 * * *" });
  await call("routine_update", { routine: "abcd5678", cron: "" });
  assert.deepEqual(routines.sent.patches, [
    { id: "abcd1234", patch: { payload: { kind: "prompt", prompt: "New words." }, trigger: { kind: "cron", expression: "30 7 * * *" } } },
    { id: "abcd5678", patch: { trigger: { kind: "manual" } } },
  ]);
});

test("routine_update with nothing to change says so and changes nothing", async () => {
  const { call, routines } = withRoutines();
  assert.match(await call("routine_update", { routine: "Morning brief" }), /Nothing to change/);
  assert.deepEqual(routines.sent.patches, []);
});

test("routine_run starts the routine and waits for it, for no more than five minutes", async () => {
  const { call, routines, waited } = withRoutines();
  assert.equal(await call("routine_run", { routine: "Evening wrap" }), "waited");
  await call("routine_run", { routine: "Evening wrap", waitSeconds: 20 });
  await call("routine_run", { routine: "Evening wrap", waitSeconds: 99_999 });
  await call("routine_run", { routine: "Evening wrap", waitSeconds: -5 });
  assert.deepEqual(routines.sent.ran, ["abcd5678", "abcd5678", "abcd5678", "abcd5678"]);
  assert.deepEqual(waited.map(([, , ms]) => ms), [90_000, 20_000, 300_000, 90_000]);
  assert.deepEqual(waited[0]!.slice(0, 2), ["abcd5678", "run_1"]);
});

test("every tool says in one line what it is about to do, for the approval card", () => {
  const { tool } = setup({ routines: fakeRoutines() });
  assert.equal(tool("bot_create").summarize({ name: "Ada", job: "x" }), "create the Bot Ada");
  assert.equal(tool("skill_save").summarize({ name: "weekly-report" }), "save the skill weekly-report");
  assert.equal(tool("routine_create").summarize({ name: "Brief" }), "create the routine Brief");
  assert.equal(tool("routine_update").summarize({ routine: "Brief" }), "change the routine Brief");
  assert.equal(tool("routine_delete").summarize({ routine: "Brief" }), "delete the routine Brief");
  assert.equal(tool("routine_run").summarize({ routine: "Brief" }), "run the routine Brief");
  assert.equal(tool("routine_create").summarize({}), "create the routine (unnamed)");
});
