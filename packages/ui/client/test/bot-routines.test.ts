import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationInfo } from "@deyin/contract";
import { ROUTINE_LIMITS } from "@deyin/host-core/shared";
import {
  addBlockFor,
  attemptRoutineAction,
  canAddRoutine,
  emptyRoutineForm,
  isEditableRoutine,
  routineFormFromInfo,
  routineHint,
  routineInput,
  routineProblem,
  routineRows,
  saveRoutine,
  type RoutineForm,
  type RoutinesApi,
} from "../src/bots/botRoutines.js";

const NOW = new Date(2026, 0, 5, 12, 0, 0);
const DEFAULTS = { model: "GLM-5.2", providerId: "openference" };

function info(over: Partial<AutomationInfo> = {}): AutomationInfo {
  return {
    id: "a1",
    botId: "ada",
    name: "Digest",
    enabled: true,
    payload: { kind: "prompt", prompt: "Summarise" },
    trigger: { kind: "cron", expression: "0 9 * * *" },
    target: { kind: "local", workspacePath: "/bots/ada/files" },
    model: "GLM-5.2",
    providerId: "openference",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function form(over: Partial<RoutineForm> = {}): RoutineForm {
  return { ...emptyRoutineForm(NOW), name: "Digest", instruction: "Summarise the news", ...over };
}

test("a new form is empty but schedulable", () => {
  const f = emptyRoutineForm(NOW);
  assert.equal(f.name, "");
  assert.equal(f.instruction, "");
  assert.equal(f.schedule.repeat, "daily");
});

test("a form needs a name, then an instruction", () => {
  assert.equal(routineProblem(form({ name: "  " }), NOW.getTime()), "bot.routines.err.name");
  assert.equal(routineProblem(form({ instruction: "" }), NOW.getTime()), "bot.routines.err.instruction");
  assert.equal(routineProblem(form({ name: "", instruction: "" }), NOW.getTime()), "bot.routines.err.name");
  assert.equal(routineProblem(form(), NOW.getTime()), null);
});

test("a schedule problem blocks saving and names the field", () => {
  const weekly = form({ schedule: { ...emptyRoutineForm(NOW).schedule, repeat: "weekly", weekdays: [] } });
  assert.equal(routineProblem(weekly, NOW.getTime()), "automations.issue.weekday");
  const past = form({ schedule: { ...emptyRoutineForm(NOW).schedule, repeat: "once", date: "2020-01-01", time: "09:00" } });
  assert.equal(routineProblem(past, NOW.getTime()), "automations.issue.past");
});

test("running more often than every five minutes is refused before saving", () => {
  const minutely = (interval: string) => form({ schedule: { ...emptyRoutineForm(NOW).schedule, repeat: "minutely", interval } });
  assert.equal(routineProblem(minutely("1"), NOW.getTime()), "bot.routines.err.spacing");
  assert.equal(routineProblem(minutely("4"), NOW.getTime()), "bot.routines.err.spacing");
  assert.equal(routineProblem(minutely("5"), NOW.getTime()), null);
  assert.equal(routineProblem(minutely("30"), NOW.getTime()), null);
});

test("while typing, only a schedule problem is shown; an unfinished form is not nagged", () => {
  assert.equal(routineHint(emptyRoutineForm(NOW), NOW.getTime()), null);
  const bad = emptyRoutineForm(NOW);
  bad.schedule = { ...bad.schedule, repeat: "minutely", interval: "2" };
  assert.equal(routineHint(bad, NOW.getTime()), "bot.routines.err.spacing", "shown even before the name is filled in");
});

test("the saved input carries the Bot, the instruction, the schedule and the chosen model", () => {
  const input = routineInput("ada", form({ name: "  Digest  ", instruction: "  Go  " }), DEFAULTS);
  assert.equal(input.botId, "ada");
  assert.equal(input.name, "Digest");
  assert.deepEqual(input.payload, { kind: "prompt", prompt: "Go" });
  assert.equal(input.trigger.kind, "cron");
  assert.equal(input.model, "GLM-5.2");
  assert.equal(input.providerId, "openference");
  assert.equal(input.enabled, true);
});

test("editing round-trips: a stored routine becomes a form and back to the same schedule", () => {
  const stored = info({ trigger: { kind: "cron", expression: "30 8 * * 1-5" } });
  const f = routineFormFromInfo(stored, NOW);
  assert.equal(f.name, "Digest");
  assert.equal(f.instruction, "Summarise");
  assert.equal(f.schedule.repeat, "weekdays");
  assert.deepEqual(routineInput("ada", f, DEFAULTS).trigger, stored.trigger);
});

test("only prompt routines are editable here; skill and subagent ones go to Automations", () => {
  assert.equal(isEditableRoutine(info()), true);
  assert.equal(isEditableRoutine(info({ payload: { kind: "skill", skill: "s" } })), false);
  assert.equal(isEditableRoutine(info({ payload: { kind: "subagent", subagent: "x" } })), false);
});

test("a Bot's routines are listed by name, and other Bots' and plain automations are left out", () => {
  const rows = routineRows(
    [info({ id: "1", name: "zeta" }), info({ id: "2", name: "Alpha" }), info({ id: "3", name: "mid", botId: "bo" }), info({ id: "4", name: "plain", botId: undefined })],
    "ada",
  );
  assert.deepEqual(rows.map((r) => r.name), ["Alpha", "zeta"]);
});

test("equal names keep a stable order by id, and the input is not reordered", () => {
  const input = [info({ id: "b", name: "Same" }), info({ id: "a", name: "Same" })];
  assert.deepEqual(routineRows(input, "ada").map((r) => r.id), ["a", "b"]);
  assert.deepEqual(input.map((r) => r.id), ["b", "a"]);
});

test("a Bot can add routines until it has fifty", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => info({ id: `r${i}` }));
  assert.equal(canAddRoutine(many(ROUTINE_LIMITS.perBot - 1), "ada"), true);
  assert.equal(canAddRoutine(many(ROUTINE_LIMITS.perBot), "ada"), false);
  assert.equal(canAddRoutine(many(ROUTINE_LIMITS.perBot), "bo"), true);
});

interface Calls {
  create: unknown[];
  update: Array<[string, unknown]>;
}

function fakeApi(over: Partial<Pick<RoutinesApi, "create" | "update">> = {}): { api: Pick<RoutinesApi, "create" | "update">; calls: Calls } {
  const calls: Calls = { create: [], update: [] };
  const api = {
    create: async (input: unknown) => {
      calls.create.push(input);
      return { automation: info({ id: "new" }), list: [info({ id: "new" })] };
    },
    update: async (id: string, patch: unknown) => {
      calls.update.push([id, patch]);
      return { automation: info({ id }), list: [info({ id })] };
    },
    ...over,
  } as unknown as Pick<RoutinesApi, "create" | "update">;
  return { api, calls };
}

test("saving a new routine creates it and returns the new list", async () => {
  const { api, calls } = fakeApi();
  const out = await saveRoutine(api, "ada", form(), null, DEFAULTS);
  assert.deepEqual([out.ok, out.ok ? out.id : ""], [true, "new"]);
  assert.equal(calls.create.length, 1);
  assert.equal((calls.create[0] as { botId: string }).botId, "ada");
});

test("a host refusal comes back as text, not a thrown error", async () => {
  const { api } = fakeApi({
    create: async () => {
      throw new Error("A Bot can have at most 50 routines. Delete one to add another.");
    },
  });
  const out = await saveRoutine(api, "ada", form(), null, DEFAULTS);
  assert.deepEqual(out, { ok: false, error: "A Bot can have at most 50 routines. Delete one to add another." });
});

test("editing sends only what a person can change, never the Bot, folder, model or enabled state", async () => {
  const { api, calls } = fakeApi();
  const existing = info({ trigger: { kind: "cron", expression: "0 9 * * *" } });
  await saveRoutine(api, "ada", form({ name: "Renamed", schedule: routineFormFromInfo(existing, NOW).schedule }), existing, DEFAULTS);
  assert.equal(calls.update.length, 1);
  const [id, patch] = calls.update[0]!;
  assert.equal(id, "a1");
  assert.deepEqual(Object.keys(patch as object).sort(), ["name", "payload"], "an unchanged schedule is not re-sent");
});

test("a changed schedule is sent with the edit", async () => {
  const { api, calls } = fakeApi();
  const existing = info({ trigger: { kind: "cron", expression: "0 9 * * *" } });
  const f = routineFormFromInfo(existing, NOW);
  f.schedule = { ...f.schedule, repeat: "weekdays", time: "07:30" };
  await saveRoutine(api, "ada", f, existing, DEFAULTS);
  const patch = calls.update[0]![1] as { trigger: { expression: string } };
  assert.equal(patch.trigger.expression, "30 7 * * 1-5");
});

test("an update refusal is text too", async () => {
  const { api } = fakeApi({
    update: async () => {
      throw new Error("A routine cannot move to another Bot.");
    },
  });
  assert.deepEqual(await saveRoutine(api, "ada", form(), info(), DEFAULTS), { ok: false, error: "A routine cannot move to another Bot." });
});

test("attemptRoutineAction hands back a returned list, tolerates other results, and turns a throw into text", async () => {
  const list = [info()];
  assert.deepEqual(await attemptRoutineAction(async () => list), { ok: true, list });
  assert.deepEqual(await attemptRoutineAction(async () => ({ id: "run" })), { ok: true });
  assert.deepEqual(
    await attemptRoutineAction(async () => {
      throw new Error("nope");
    }),
    { ok: false, error: "nope" },
  );
  assert.deepEqual(
    await attemptRoutineAction(async () => {
      throw "plain";
    }),
    { ok: false, error: "plain" },
  );
});

test("what blocks a new routine: archived first, then the limit, then a missing model", () => {
  const full = Array.from({ length: ROUTINE_LIMITS.perBot }, (_, i) => info({ id: `r${i}` }));
  const bot = { id: "ada", archived: false };
  assert.equal(addBlockFor([], bot, DEFAULTS), null);
  assert.equal(addBlockFor([], { ...bot, archived: true }, DEFAULTS), "archived");
  assert.equal(addBlockFor(full, bot, DEFAULTS), "limit");
  assert.equal(addBlockFor([], bot, { ...DEFAULTS, model: "" }), "noModel");
  assert.equal(addBlockFor(full, { ...bot, archived: true }, { ...DEFAULTS, model: "" }), "archived", "archived outranks the rest");
  assert.equal(addBlockFor(full, bot, { ...DEFAULTS, model: "" }), "limit", "the limit outranks a missing model");
  assert.equal(addBlockFor(full, { id: "bo", archived: false }, DEFAULTS), null, "another Bot's routines do not count");
});
