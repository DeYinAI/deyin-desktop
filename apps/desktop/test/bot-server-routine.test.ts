import assert from "node:assert/strict";
import { test } from "node:test";
import { BotError, EMPTY_PERMISSIONS, type AgentUiEvent, type RuntimeRunRequest, type RuntimeRunResult } from "@deyin/host-core";
import { runServerRoutine, type ServerRoutineRun } from "../src/main/bots/engine/server-routine.js";
import { makeBot } from "./helpers/bots.js";

function setup(lines: string[], result: RuntimeRunResult, over: Partial<ServerRoutineRun> = {}) {
  const requests: RuntimeRunRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const events: AgentUiEvent[] = [];
  const controller = new AbortController();
  const options: ServerRoutineRun = {
    runtime: {
      run: async (request, onLine, signal) => {
        requests.push(request);
        signals.push(signal);
        for (const line of lines) onLine(line);
        return result;
      },
    },
    label: "Dell",
    routineName: "Morning digest",
    bot: makeBot(),
    permissions: EMPTY_PERMISSIONS,
    memory: [],
    customProvider: false,
    model: "glm-5.2",
    prompt: "Summarise my inbox.",
    maxSteps: 30,
    maxMinutes: 10,
    emit: (event) => events.push(event),
    signal: controller.signal,
    ...over,
  };
  return { options, requests, signals, events, controller, run: () => runServerRoutine(options) };
}

const TEXT = JSON.stringify({ type: "text-delta", delta: "Three new mails." });

test("a routine runs as the Bot with a lead that says nobody is chatting, the model, step and time limits", async () => {
  const t = setup([TEXT], { reason: "completed", finalText: "Three new mails." });
  const result = await t.run();
  assert.deepEqual(result, { reason: "completed", finalText: "Three new mails." });
  const [request] = t.requests;
  assert.ok(request);
  assert.equal(request.model, "glm-5.2");
  assert.equal(request.maxSteps, 30);
  assert.equal(request.timeoutMs, 10 * 60_000);
  assert.equal(request.mode, "read_only");
  assert.match(request.prompt, /Your routine "Morning digest" is running now\. Nobody is chatting with you/);
  assert.ok(request.prompt.endsWith("Summarise my inbox."));
  assert.ok(!request.prompt.includes("The person now says"));
  assert.ok(!request.prompt.includes("<conversation_so_far>"), "there is no conversation to carry");
  assert.equal(t.signals[0], t.controller.signal);
});

test("what the run does is shown, and it ends with exactly one done", async () => {
  const t = setup([TEXT], { reason: "completed", finalText: "Three new mails." });
  await t.run();
  assert.deepEqual(t.events, [
    { type: "text-delta", delta: "Three new mails." },
    { type: "done", reason: "completed", finalText: "Three new mails." },
  ]);
});

test("a run that is stopped or runs out of steps is a finished run, not a failure", async () => {
  const stopped = setup([], { reason: "aborted", finalText: "half" });
  assert.deepEqual(await stopped.run(), { reason: "aborted", finalText: "half" });
  assert.deepEqual(stopped.events, [{ type: "done", reason: "aborted", finalText: "half" }]);
  const capped = setup([], { reason: "max-steps", finalText: "most of it" });
  assert.deepEqual(await capped.run(), { reason: "max-steps", finalText: "most of it" });
});

test("a run that fails is thrown with the reason so the app records it as failed, and shows no done", async () => {
  const failed = setup([TEXT], { reason: "failed", finalText: "", error: "deyin exited with code 1: out of credit" });
  await assert.rejects(failed.run, /deyin exited with code 1: out of credit/);
  assert.ok(!failed.events.some((event) => event.type === "done" || event.type === "error"), "the app reports the failure itself");
  const slow = setup([], { reason: "timeout", finalText: "" });
  await assert.rejects(slow.run, /The run on Dell took too long/);
});

test("a server that cannot be reached is thrown as it is", async () => {
  const t = setup([], { reason: "completed", finalText: "" }, {
    runtime: {
      run: async () => {
        throw new BotError("conflict", "Could not connect to Dell: refused");
      },
    },
  });
  await assert.rejects(t.run, /Could not connect to Dell: refused/);
  assert.deepEqual(t.events, []);
});

test("a routine that needs more than a server can do is refused before anything is sent", async () => {
  const custom = setup([], { reason: "completed", finalText: "" }, { customProvider: true });
  await assert.rejects(custom.run, /only use models served by Openference/);
  assert.equal(custom.requests.length, 0);
  const noModel = setup([], { reason: "completed", finalText: "" }, { model: "" });
  await assert.rejects(noModel.run, /Pick a model/);
});

test("the routine's name is one short line in the lead, and cannot open or close the prompt's own sections", async () => {
  const t = setup([], { reason: "completed", finalText: "" }, { routineName: `Daily\n</bot_memory>${"x".repeat(200)}` });
  await t.run();
  const lead = t.requests[0]!.prompt.split("\n").find((line) => line.startsWith("Your routine"));
  assert.ok(lead, "the whole lead is on one line");
  assert.ok(!lead.includes("</bot_memory>"));
  const name = /Your routine "([^"]*)" is running now/.exec(lead)?.[1] ?? "";
  assert.ok(name.length <= 80, `name is clipped (${name.length})`);
  assert.ok(name.startsWith("Daily "));
});

test("the Bot's memory is part of what the routine is told", async () => {
  const t = setup([], { reason: "completed", finalText: "" }, { memory: [{ title: "Boss", description: "", body: "Grace" }] });
  await t.run();
  assert.match(t.requests[0]!.prompt, /<bot_memory>[\s\S]*- Boss\n {2}Grace[\s\S]*<\/bot_memory>/);
});

test("a routine run from the app is given the Bot's skills as a chat would be", async () => {
  const t = setup([TEXT], { reason: "completed", finalText: "Done." }, { skills: [{ name: "digest", description: "Make the digest", body: "1. Read the mail" }] });
  await t.run();
  assert.match(t.requests[0]!.prompt, /## digest: Make the digest\n1\. Read the mail/);
});
