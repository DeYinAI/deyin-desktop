import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BotError,
  EMPTY_PERMISSIONS,
  RUNTIME_LIMITS,
  type AgentUiEvent,
  type BotPermissionSettings,
  type RuntimeRunRequest,
  type RuntimeRunResult,
} from "@deyin/host-core";
import {
  buildServerRunRequest,
  describeServerEnd,
  earlierTurns,
  runServerBotTurn,
  serverTurnRefusal,
  type ServerTurnInput,
} from "../src/main/bots/engine/server-chat.js";
import { makeBot } from "./helpers/bots.js";

const rules = (scopes: BotPermissionSettings["scopes"]): BotPermissionSettings => ({ ...EMPTY_PERMISSIONS, scopes });

function input(over: Partial<ServerTurnInput> = {}): ServerTurnInput {
  return {
    bot: makeBot(),
    permissions: EMPTY_PERMISSIONS,
    memory: [],
    history: [],
    prompt: "What is on my calendar?",
    model: "glm-5.2",
    customProvider: false,
    imageCount: 0,
    ...over,
  };
}

/** A runtime that says what it was asked and plays back lines, then ends the way the test says. */
function runtime(lines: string[], result: RuntimeRunResult) {
  const calls: Array<{ request: RuntimeRunRequest; signal?: AbortSignal }> = [];
  return {
    calls,
    run: async (request: RuntimeRunRequest, onLine: (line: string) => void, signal?: AbortSignal) => {
      calls.push({ request, signal });
      for (const line of lines) onLine(line);
      return result;
    },
  };
}

async function play(over: Partial<ServerTurnInput>, lines: string[], result: RuntimeRunResult, signal?: AbortSignal) {
  const rt = runtime(lines, result);
  const events: AgentUiEvent[] = [];
  await runServerBotTurn(rt, input(over), (event) => events.push(event), { label: "Dell", signal });
  return { events, rt };
}

async function refusal(over: Partial<ServerTurnInput>, pattern: RegExp): Promise<void> {
  const rt = runtime([], { reason: "completed", finalText: "" });
  await assert.rejects(
    () => runServerBotTurn(rt, input(over), () => assert.fail("nothing is shown for a run that was refused"), { label: "Dell" }),
    (error: unknown) => error instanceof BotError && error.code === "invalid" && pattern.test(error.message),
  );
  assert.equal(rt.calls.length, 0, "nothing was sent to the server");
}

const LINES = [
  "npm warn something on the server",
  JSON.stringify({ type: "text-delta", delta: "You have " }),
  JSON.stringify({ type: "tool-start", call: { id: "c1", name: "read_file" }, summary: "Read notes.md" }),
  JSON.stringify({ type: "tool-end", call: { id: "c1", name: "read_file" }, result: "two meetings", ok: true }),
  JSON.stringify({ type: "text-delta", delta: "two meetings." }),
  JSON.stringify({ type: "result", reason: "completed", finalText: "CLI's own summary" }),
];

test("what the engine streams is shown as a local run's would be, ending in one done built from how the run ended", async () => {
  const { events } = await play({}, LINES, { reason: "completed", finalText: "You have two meetings." });
  assert.deepEqual(events, [
    { type: "text-delta", delta: "You have " },
    { type: "tool-start", callId: "c1", name: "read_file", summary: "Read notes.md" },
    { type: "tool-end", callId: "c1", name: "read_file", summary: "", result: "two meetings", ok: true, denied: undefined },
    { type: "text-delta", delta: "two meetings." },
    { type: "done", reason: "completed", finalText: "You have two meetings." },
  ]);
  assert.equal(events.filter((event) => event.type === "done").length, 1, "the CLI's own done is not passed on");
});

test("the engine is asked for the persona (told it has no memory tools), what it remembers, the conversation and the task", async () => {
  const { rt } = await play(
    {
      bot: makeBot({ purpose: "Keep my calendar." }),
      memory: [{ title: "Timezone", description: "Where I am", body: "Europe/Berlin" }],
      history: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
    },
    [],
    { reason: "completed", finalText: "" },
  );
  const { request } = rt.calls[0]!;
  assert.equal(request.model, "glm-5.2");
  assert.equal(request.mode, "read_only");
  assert.match(request.prompt, /^<bot_identity>\nYou are Ada/);
  assert.match(request.prompt, /You cannot save new memories in this conversation/);
  assert.doesNotMatch(request.prompt, /scope `project`/);
  assert.match(request.prompt, /<bot_memory>[\s\S]*Timezone: Where I am[\s\S]*Europe\/Berlin/);
  assert.match(request.prompt, /User: Hi\n\nYou: Hello/);
  assert.ok(request.prompt.endsWith("The person now says:\nWhat is on my calendar?"));
});

test("the approval mode decides what the server may do: run everything runs everything; read only and Auto Review read", () => {
  const mode = (approvalMode: "auto_review" | "read_only" | "run_everything") => buildServerRunRequest(input({ bot: makeBot({ autoReview: { approvalMode } }) })).mode;
  assert.equal(mode("run_everything"), "run_everything");
  assert.equal(mode("read_only"), "read_only");
  assert.equal(mode("auto_review"), "read_only");
});

test("a run that did not finish says why, then ends as stopped, with no answer", async () => {
  const failed = await play({}, [], { reason: "failed", finalText: "partial", error: "deyin exited with code 1: no network" });
  assert.deepEqual(failed.events, [
    { type: "error", message: "deyin exited with code 1: no network" },
    { type: "done", reason: "aborted", finalText: "" },
  ]);
  const bare = await play({}, [], { reason: "failed", finalText: "" });
  assert.deepEqual(bare.events[0], { type: "error", message: "The run on Dell failed." });
  const slow = await play({}, [], { reason: "timeout", finalText: "partial" });
  assert.deepEqual(slow.events, [
    { type: "error", message: "The run on Dell took too long and was stopped." },
    { type: "done", reason: "aborted", finalText: "" },
  ]);
});

test("stopping or running out of steps is not an error, and keeps what was said", async () => {
  const stopped = await play({}, [], { reason: "aborted", finalText: "half an answer" });
  assert.deepEqual(stopped.events, [{ type: "done", reason: "aborted", finalText: "half an answer" }]);
  const capped = await play({}, [], { reason: "max-steps", finalText: "so far" });
  assert.deepEqual(capped.events, [{ type: "done", reason: "max-steps", finalText: "so far" }]);
});

test("the person's stop reaches the engine's run", async () => {
  const controller = new AbortController();
  const { rt } = await play({}, [], { reason: "aborted", finalText: "" }, controller.signal);
  assert.equal(rt.calls[0]!.signal, controller.signal);
});

test("problems reaching the server are thrown for the caller's own error path, with nothing shown", async () => {
  const unreachable = {
    run: async (): Promise<RuntimeRunResult> => {
      throw new BotError("conflict", "Could not connect to Dell: timed out");
    },
  };
  await assert.rejects(
    () => runServerBotTurn(unreachable, input(), () => assert.fail("no events"), { label: "Dell" }),
    /Could not connect to Dell/,
  );
});

test("what a server cannot do is refused in words, before anything is sent", async () => {
  await refusal({ customProvider: true }, /only use models served by Openference/);
  await refusal({ imageCount: 1 }, /Pictures cannot be sent to a Bot that runs on a server/);
  await refusal({ model: "" }, /Pick a model/);
  await refusal({ model: "two words" }, /Pick a model/);
  await refusal({ model: "m".repeat(201) }, /Pick a model/);
  await refusal(
    { bot: makeBot({ autoReview: { approvalMode: "run_everything" } }), permissions: rules({ local: { tools: { shell: "blocked" } } }) },
    /blocked or set to ask first/,
  );
  await refusal({ prompt: "  " }, /nothing to send/i);
});

test("the same rules do not stop a Bot that only reads, whatever its tool rules say", () => {
  const blocked = rules({ local: { tools: { shell: "blocked" } } });
  assert.equal(serverTurnRefusal({ ...input({ permissions: blocked }), bot: makeBot({ autoReview: { approvalMode: "read_only" } }) }), null);
  assert.equal(serverTurnRefusal({ ...input({ permissions: blocked }), bot: makeBot({ autoReview: { approvalMode: "auto_review" } }) }), null);
  assert.equal(serverTurnRefusal(input()), null);
  assert.equal(serverTurnRefusal(input({ model: "provider::model" })), null);
});

test("the step limit is passed on only when there is one, and kept within what the engine accepts", () => {
  const steps = (maxSteps: number | null | undefined) => buildServerRunRequest(input({ maxSteps })).maxSteps;
  assert.equal(steps(undefined), undefined);
  assert.equal(steps(null), undefined);
  assert.equal(steps(Number.NaN), undefined);
  assert.equal(steps(Number.POSITIVE_INFINITY), undefined);
  assert.equal(steps(40), 40);
  assert.equal(steps(7.9), 7);
  assert.equal(steps(0), 1);
  assert.equal(steps(-5), 1);
  assert.equal(steps(5_000), 1_000);
});

test("a time limit is passed on, within the longest a run may last", () => {
  const limit = (timeoutMs: number | undefined) => buildServerRunRequest(input({ timeoutMs })).timeoutMs;
  assert.equal(limit(undefined), undefined);
  assert.equal(limit(0), undefined);
  assert.equal(limit(-1), undefined);
  assert.equal(limit(90_000), 90_000);
  assert.equal(limit(10 * RUNTIME_LIMITS.runTimeoutMaxMs), RUNTIME_LIMITS.runTimeoutMaxMs);
});

test("a task can be introduced as something other than the person speaking", () => {
  const request = buildServerRunRequest(input({ lead: "Your routine is running now." }));
  assert.ok(request.prompt.endsWith("Your routine is running now.\nWhat is on my calendar?"));
  assert.ok(!request.prompt.includes("The person now says"));
});

test("the message the person just sent is not said twice when the conversation already ends with it", () => {
  const history = [
    { role: "assistant" as const, content: "Hello" },
    { role: "user" as const, content: "What is on my calendar?" },
  ];
  assert.deepEqual(earlierTurns(history, "What is on my calendar?"), [history[0]]);
  assert.deepEqual(earlierTurns(history, "  What is on my calendar?\n"), [history[0]], "spacing does not matter");
  assert.deepEqual(earlierTurns(history, "What is on my calendar?\n\n<attached>notes.md</attached>"), [history[0]], "nor does attached context after it");
  assert.deepEqual(earlierTurns(history, "Something else"), history, "a different last message is real history");
  assert.deepEqual(earlierTurns([history[1]!, history[0]!], "What is on my calendar?"), [history[1], history[0]], "only the last turn is looked at, and only if it is the person's");
  assert.deepEqual(earlierTurns([], "x"), []);
  assert.deepEqual(earlierTurns([{ role: "user", content: "  " }], "x"), [{ role: "user", content: "  " }], "a blank turn is not mistaken for the task");
  const request = buildServerRunRequest(input({ history }));
  assert.equal(request.prompt.match(/What is on my calendar\?/g)?.length, 1);
});

test("how a run ends is described the same way everywhere", () => {
  assert.equal(describeServerEnd({ reason: "completed", finalText: "" }, "Dell"), null);
  assert.equal(describeServerEnd({ reason: "max-steps", finalText: "" }, "Dell"), null);
  assert.equal(describeServerEnd({ reason: "aborted", finalText: "" }, "Dell"), null);
  assert.equal(describeServerEnd({ reason: "timeout", finalText: "" }, "Dell"), "The run on Dell took too long and was stopped.");
  assert.equal(describeServerEnd({ reason: "failed", finalText: "", error: "  boom  " }, "Dell"), "boom");
  assert.equal(describeServerEnd({ reason: "failed", finalText: "", error: "   " }, "Dell"), "The run on Dell failed.");
});

test("a Bot's skills are written into the prompt the engine is given, and left out when it has none", () => {
  const withSkills = buildServerRunRequest(input({ skills: [{ name: "weekly-report", description: "Write the weekly report", body: "1. Open the sheet" }] }));
  assert.match(withSkills.prompt, /<bot_skills>\n[\s\S]*## weekly-report: Write the weekly report\n1\. Open the sheet/);
  assert.doesNotMatch(buildServerRunRequest(input()).prompt, /bot_skills/);
  assert.doesNotMatch(buildServerRunRequest(input({ skills: [] })).prompt, /bot_skills/);
});
