import assert from "node:assert/strict";
import test from "node:test";
import { ROUTINE_LIMITS, type Automation, type BotResult } from "@deyin/host-core";
import { prepareNewRoutine, prepareRoutinePatch, type RoutineEnv } from "../src/main/automations/routine-input.js";

const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);

type New = Omit<Automation, "id" | "createdAt" | "updatedAt">;

const routine = (patch: Partial<New> = {}): New => ({
  botId: "ada",
  name: "Morning digest",
  enabled: true,
  payload: { kind: "prompt", prompt: "Summarise the news" },
  trigger: { kind: "cron", expression: "0 9 * * *" },
  target: { kind: "ssh", hostId: "h1", workspacePath: "/somewhere/else" },
  model: "m",
  providerId: "openference",
  ...patch,
});

function env(over: Partial<RoutineEnv> = {}): RoutineEnv {
  return {
    existing: [],
    now: NOW,
    resolveBot: () => ({ ok: true, value: { cwd: "/data/bots/ada/files" } }),
    ...over,
  };
}

const refused = (error: string): BotResult<{ cwd: string }> => ({ ok: false, error, code: "conflict" });

test("a new routine is pinned to its Bot's folder, whatever target was sent", () => {
  const out = prepareNewRoutine(routine(), env());
  assert.deepEqual(out.target, { kind: "local", workspacePath: "/data/bots/ada/files" });
  assert.equal(out.botId, "ada");
  assert.equal(out.name, "Morning digest", "everything else is untouched");
});

test("a routine needs a Bot", () => {
  assert.throws(() => prepareNewRoutine(routine({ botId: undefined }), env()), /needs a Bot/);
  assert.throws(() => prepareNewRoutine(routine({ botId: "" }), env()), /needs a Bot/);
});

test("a Bot that cannot run cannot take a routine, and the reason is the Bot's own", () => {
  assert.throws(
    () => prepareNewRoutine(routine(), env({ resolveBot: () => refused("Ada is archived. Restore it to chat with it.") })),
    /Ada is archived/,
  );
});

test("the 51st routine for one Bot is refused; another Bot's routines do not count", () => {
  const owned = (botId: string, n: number) => Array.from({ length: n }, () => ({ botId }));
  assert.doesNotThrow(() => prepareNewRoutine(routine(), env({ existing: owned("ada", ROUTINE_LIMITS.perBot - 1) })));
  assert.throws(() => prepareNewRoutine(routine(), env({ existing: owned("ada", ROUTINE_LIMITS.perBot) })), /at most 50 routines/);
  assert.doesNotThrow(() => prepareNewRoutine(routine(), env({ existing: [...owned("bo", 60), ...Array.from({ length: 60 }, () => ({}))] })));
});

test("a routine may not run more often than every five minutes", () => {
  assert.throws(() => prepareNewRoutine(routine({ trigger: { kind: "cron", expression: "* * * * *" } }), env()), /once every 5 minutes/);
  assert.doesNotThrow(() => prepareNewRoutine(routine({ trigger: { kind: "cron", expression: "*/5 * * * *" } }), env()));
  assert.doesNotThrow(() => prepareNewRoutine(routine({ trigger: { kind: "manual" } }), env()));
  assert.doesNotThrow(() => prepareNewRoutine(routine({ trigger: { kind: "once", at: NOW + 1000 } }), env()));
});

test("a refused routine reports one problem and saves nothing (quota is checked before the schedule)", () => {
  assert.throws(
    () => prepareNewRoutine(routine({ trigger: { kind: "cron", expression: "* * * * *" } }), env({ existing: Array.from({ length: 50 }, () => ({ botId: "ada" })) })),
    /at most 50 routines/,
  );
});

test("editing a routine cannot move it to another Bot or out of its folder", () => {
  const existing = { botId: "ada" };
  assert.throws(() => prepareRoutinePatch(existing, { botId: "bo" }, { now: NOW }), /cannot move to another Bot/);
  assert.doesNotThrow(() => prepareRoutinePatch(existing, { botId: "ada" }, { now: NOW }));
  const out = prepareRoutinePatch(existing, { name: "Renamed", target: { kind: "local", workspacePath: "/tmp/elsewhere" } }, { now: NOW });
  assert.deepEqual(out, { name: "Renamed" }, "the target in an edit is dropped");
});

test("editing a routine's schedule is held to the same spacing", () => {
  const existing = { botId: "ada" };
  assert.throws(() => prepareRoutinePatch(existing, { trigger: { kind: "cron", expression: "*/2 * * * *" } }, { now: NOW }), /once every 5 minutes/);
  assert.deepEqual(prepareRoutinePatch(existing, { trigger: { kind: "cron", expression: "*/10 * * * *" } }, { now: NOW }), { trigger: { kind: "cron", expression: "*/10 * * * *" } });
});

test("an ordinary automation is edited as before, and cannot be made into a routine", () => {
  const patch = { trigger: { kind: "cron" as const, expression: "* * * * *" }, target: { kind: "local" as const, workspacePath: "/p" } };
  assert.deepEqual(prepareRoutinePatch({}, patch, { now: NOW }), patch, "no routine rules apply to it");
  assert.throws(() => prepareRoutinePatch({}, { botId: "ada" }, { now: NOW }), /cannot be turned into a routine/);
});
