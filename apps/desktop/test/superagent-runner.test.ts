import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import {
  AuthRequiredError,
  ProviderHttpError,
  createBuiltinRegistry,
  type AgentMessage,
  type AgentRunOptions,
  type AgentRunResult,
} from "@deyin/agent-core";
import { AgentRunError, type AgentRunRequest, type AgentTool, type Logger } from "@deyin/superagent";
import { SessionHistory, repairHistory, sessionFileName } from "../src/main/superagent/history.js";
import { AgentCoreRunner, UNATTENDED_NOTE, parseModelId, type RunnerDeps } from "../src/main/superagent/runner.js";
import { WORKER_BUILTIN_TOOLS, toToolDefinition } from "../src/main/superagent/tools.js";

const silent: Logger = { info: () => undefined, warn: () => undefined };
const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "superagent-runner-"));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const result = (finalText = "", reason: AgentRunResult["reason"] = "completed"): AgentRunResult => ({
  reason,
  finalText,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  steps: 1,
});

const domainTool = (name: string, execute: AgentTool["execute"] = async () => "ok"): AgentTool => ({
  name,
  description: `${name} tool`,
  parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"], additionalProperties: false },
  execute,
});

interface Fixture {
  runner: AgentCoreRunner;
  runs: AgentRunOptions[];
  sessionsDir: string;
  homeDir: string;
  setHandler(handler: (options: AgentRunOptions, index: number) => Promise<AgentRunResult> | AgentRunResult): void;
}

let fixture: Fixture;
let defaultModel: { providerId: string; model: string } | null;

function makeFixture(): Fixture {
  const sessionsDir = join(tempDir(), "sessions");
  const homeDir = tempDir();
  const runs: AgentRunOptions[] = [];
  let handler: (options: AgentRunOptions, index: number) => Promise<AgentRunResult> | AgentRunResult = () => result("done");
  const deps: RunnerDeps = {
    sessionsDir,
    homeDir,
    logger: silent,
    saveDebounceMs: 5,
    defaultModel: () => defaultModel,
    route: (providerId) => ({ apiBaseUrl: `https://api.example/${providerId}`, getToken: async () => "tok" }),
    contextLength: (_providerId, model) => (model === "big" ? 200_000 : undefined),
    options: () => ({ maxSteps: 40, thinking: false }),
    builtinTools: () => createBuiltinRegistry(),
    run: async (options) => {
      runs.push(options);
      return handler(options, runs.length - 1);
    },
  };
  return { runner: new AgentCoreRunner(deps), runs, sessionsDir, homeDir, setHandler: (next) => void (handler = next) };
}

beforeEach(() => {
  defaultModel = { providerId: "openference", model: "default-model" };
  fixture = makeFixture();
});

const request = (patch: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  role: "worker",
  sessionId: "t1",
  systemPrompt: "SYSTEM",
  tools: [],
  cwd: "/work/t1",
  env: { GH_TOKEN: "secret" },
  blockedCommands: [],
  model: null,
  messages: ["hello"],
  drain: () => [],
  signal: new AbortController().signal,
  ...patch,
});

test("a worker run gets its directory, environment, model routing and an allow-listed toolset", async () => {
  const out = await fixture.runner.run(request({ model: { providerId: "acme", model: "big" }, tools: [domainTool("orchestrator_report")] }));
  assert.equal(out.finalText, "done");
  const options = fixture.runs[0]!;
  assert.equal(options.cwd, "/work/t1");
  assert.equal(options.model, "big");
  assert.equal(options.apiBaseUrl, "https://api.example/acme");
  assert.equal(options.contextLength, 200_000);
  assert.equal(options.maxSteps, 40);
  assert.equal(options.toolContext?.env?.GH_TOKEN, "secret");
  assert.equal(options.permissions.actionFor({ name: "bash", tier: "execute" }), "allow");
  assert.equal(await options.resolvePermission({ toolName: "bash", args: {} } as never), "allow");

  const names = options.tools.names();
  assert.ok(names.includes("orchestrator_report"));
  assert.ok(names.includes("bash") && names.includes("edit") && names.includes("read"));
  for (const name of names.filter((tool) => tool !== "orchestrator_report")) assert.ok(WORKER_BUILTIN_TOOLS.includes(name), `${name} is not on the worker allow-list`);
  for (const forbidden of ["ask_question", "memory", "remember", "enter_worktree", "generate_image", "delegate_external_bot", "create_plan", "chrome_navigate"]) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be offered to a worker`);
  }

  const system = options.messages[0]!;
  assert.equal(system.role, "system");
  assert.equal((system as { content: string }).content, `SYSTEM${UNATTENDED_NOTE}`);
  assert.deepEqual(options.messages.slice(1), [{ role: "user", content: "hello" }]);
});

test("an orchestrator run has only its domain tools and no working directory of its own", async () => {
  await fixture.runner.run(request({ role: "orchestrator", sessionId: "orchestrator", cwd: undefined, tools: [domainTool("orchestrator_read"), domainTool("orchestrator_route")] }));
  const options = fixture.runs[0]!;
  assert.deepEqual(options.tools.names().sort(), ["orchestrator_read", "orchestrator_route"]);
  assert.equal(options.cwd, fixture.homeDir);
});

test("without a model of its own a run uses the app's default, and without any it fails for good", async () => {
  await fixture.runner.run(request());
  assert.equal(fixture.runs[0]!.model, "default-model");
  assert.equal(fixture.runs[0]!.apiBaseUrl, "https://api.example/openference");

  defaultModel = null;
  await assert.rejects(fixture.runner.run(request()), (error: unknown) => error instanceof AgentRunError && error.retryable === false && /No model is chosen/.test(error.message));
  assert.equal(fixture.runs.length, 1);
});

test("a conversation continues from its stored history, under the current system prompt", async () => {
  fixture.setHandler((options) => {
    options.messages.push({ role: "assistant", content: "first answer" });
    options.onMessage?.({ role: "assistant", content: "first answer" });
    return result("first answer");
  });
  await fixture.runner.run(request({ systemPrompt: "OLD", messages: ["one"] }));

  fixture.setHandler(() => result("second"));
  await fixture.runner.run(request({ systemPrompt: "NEW", messages: ["two"] }));

  const second = fixture.runs[1]!.messages;
  assert.deepEqual(
    second.map((message) => `${message.role}:${(message as { content: string }).content.slice(0, 12)}`),
    ["system:NEW\n\nThis co", "user:one", "assistant:first answer", "user:two"],
  );
  // The system prompt is not stored with the history, so a changed prompt applies at once.
  const stored = JSON.parse(readFileSync(join(fixture.sessionsDir, "t1.json"), "utf8")) as { messages: AgentMessage[] };
  assert.ok(stored.messages.every((message) => message.role !== "system"));
  assert.equal(stored.messages.length, 3);
});

test("a separate session keeps a separate history, and forget drops one", async () => {
  await fixture.runner.run(request({ sessionId: "a", messages: ["for a"] }));
  await fixture.runner.run(request({ sessionId: "b", messages: ["for b"] }));
  assert.deepEqual(fixture.runs[1]!.messages.slice(1), [{ role: "user", content: "for b" }]);
  assert.deepEqual(readdirSync(fixture.sessionsDir).sort(), ["a.json", "b.json"]);
  await fixture.runner.forget("a");
  assert.deepEqual(readdirSync(fixture.sessionsDir), ["b.json"]);
  await fixture.runner.run(request({ sessionId: "a", messages: ["again"] }));
  assert.deepEqual(fixture.runs[2]!.messages.slice(1), [{ role: "user", content: "again" }]);
});

test("messages that arrive mid-run join between steps, and ones that arrive as it finishes start another turn", async () => {
  const inbox = [["during"], ["after"], []];
  let polled = 0;
  const drain = () => inbox[polled++] ?? [];
  fixture.setHandler((options, index) => {
    if (index === 0) {
      // The loop asks between steps.
      const pending = options.drainPendingMessages?.();
      assert.deepEqual(pending, [{ role: "user", content: "during" }]);
      options.messages.push(...(pending ?? []));
    }
    return result(`run ${index}`);
  });
  const out = await fixture.runner.run(request({ drain }));
  assert.equal(fixture.runs.length, 2, "a message found after the run started a second one");
  assert.equal(out.finalText, "run 1");
  const contents = fixture.runs[1]!.messages.slice(1).map((message) => (message as { content: string }).content);
  assert.deepEqual(contents, ["hello", "during", "after"]);
});

test("the blocked-command screen stops a worker's shell command, and only the shell's", async () => {
  let outcomes: unknown[] = [];
  fixture.setHandler(async (options) => {
    const call = (name: string, args: Record<string, unknown>) => options.beforeTool!({ id: "c", name, arguments: JSON.stringify(args) }, args, name);
    outcomes = [
      await call("bash", { command: "ls && rm -rf build" }),
      await call("bash", { command: "echo hi | xargs rm" }),
      await call("bash", { command: "git status" }),
      await call("bash", {}),
      await call("write", { command: "rm" }),
    ];
    return result();
  });
  await fixture.runner.run(request({ blockedCommands: ["rm", "curl"] }));
  assert.match((outcomes[0] as { block: string }).block, /"rm" is blocked/);
  assert.match((outcomes[1] as { block: string }).block, /"rm" is blocked/);
  assert.equal(outcomes[2], undefined);
  assert.equal(outcomes[3], undefined);
  assert.equal(outcomes[4], undefined);
});

test("failures reach the driver as retryable or not", async () => {
  const failWith = (error: Error) => {
    fixture.setHandler(() => {
      throw error;
    });
    return fixture.runner.run(request());
  };
  await assert.rejects(failWith(new AuthRequiredError()), (error: unknown) => error instanceof AgentRunError && !error.retryable && /sign-in or an API key/.test(error.message));
  for (const status of [401, 402, 403, 404]) {
    await assert.rejects(failWith(new ProviderHttpError("nope", status)), (error: unknown) => error instanceof AgentRunError && !error.retryable && error.message.includes(String(status)));
  }
  // A provider hiccup or a plain failure is worth another go.
  for (const error of [new ProviderHttpError("overloaded", 503), new Error("socket hang up")]) {
    await assert.rejects(failWith(error), (thrown: unknown) => !(thrown instanceof AgentRunError) && thrown === error);
  }
});

test("hitting the step limit fails for good instead of leaving the worker silently idle", async () => {
  fixture.setHandler(() => result("partial", "max-steps"));
  await assert.rejects(fixture.runner.run(request()), (error: unknown) => error instanceof AgentRunError && !error.retryable && /step limit \(40\)/.test(error.message));
  // The conversation so far is kept, so a retry continues rather than starts over.
  assert.ok(existsSync(join(fixture.sessionsDir, "t1.json")));
});

test("an aborted run returns quietly, even when the loop threw because of the abort", async () => {
  const controller = new AbortController();
  fixture.setHandler(() => {
    controller.abort();
    throw new Error("The operation was aborted");
  });
  const out = await fixture.runner.run(request({ signal: controller.signal }));
  assert.equal(out.finalText, "");

  const second = new AbortController();
  fixture.setHandler(() => {
    second.abort();
    return result("stopped", "aborted");
  });
  assert.equal((await fixture.runner.run(request({ signal: second.signal, sessionId: "t2" }))).finalText, "stopped");
  assert.equal(fixture.runs.length, 2, "an abort ends the drain loop even when messages are waiting");
});

test("a conversation is saved when a run ends badly, so a retry continues it", async () => {
  fixture.setHandler((options) => {
    options.messages.push({ role: "assistant", content: "thinking" });
    throw new Error("boom");
  });
  await assert.rejects(fixture.runner.run(request({ messages: ["start"] })));
  fixture.setHandler(() => result("recovered"));
  await fixture.runner.run(request({ messages: ["retry"] }));
  assert.deepEqual(
    fixture.runs[1]!.messages.slice(1).map((message) => (message as { content: string }).content),
    ["start", "thinking", "retry"],
  );
});

test("the domain tools reach the model as read-tier tools whose results are text", async () => {
  const calls: unknown[] = [];
  const object = toToolDefinition(domainTool("orchestrator_a", async (args) => (calls.push(args), { ok: true })));
  const text = toToolDefinition(domainTool("orchestrator_b", async () => "plain"));
  const none = toToolDefinition(domainTool("orchestrator_c", async () => undefined));
  const ctx = { cwd: "/", todos: [] };
  assert.equal(object.tier, "read");
  assert.equal(object.parameters.type, "object");
  assert.deepEqual(object.parameters.required, ["x"]);
  assert.equal(await object.execute({ x: "1" }, ctx), '{"ok":true}');
  assert.deepEqual(calls, [{ x: "1" }]);
  assert.equal(await text.execute({}, ctx), "plain");
  assert.equal(await none.execute({}, ctx), "ok");
  assert.throws(() => toToolDefinition({ ...domainTool("bad"), parameters: { type: "string" } }), /JSON Schema object/);
});

test("the app's default-model setting becomes a model reference", () => {
  assert.deepEqual(parseModelId("acme::gpt-x"), { providerId: "acme", model: "gpt-x" });
  assert.deepEqual(parseModelId("gpt-x"), { providerId: "openference", model: "gpt-x" });
  assert.deepEqual(parseModelId(" acme :: a::b "), { providerId: "acme", model: "a::b" });
  for (const bad of [null, undefined, "", "  ", "::x", "acme::"]) assert.equal(parseModelId(bad), null);
});

test("repairHistory keeps a consistent prefix and drops a half-finished tool exchange", () => {
  const user = (content: string): AgentMessage => ({ role: "user", content });
  const call = (...ids: string[]): AgentMessage => ({ role: "assistant", content: "", toolCalls: ids.map((id) => ({ id, name: "bash", arguments: "{}" })) });
  const done = (id: string): AgentMessage => ({ role: "tool", toolCallId: id, toolName: "bash", content: "ok" });
  const answer: AgentMessage = { role: "assistant", content: "fine" };

  assert.deepEqual(repairHistory([]), []);
  assert.deepEqual(repairHistory([user("a"), call("1", "2"), done("1"), done("2"), answer]), [user("a"), call("1", "2"), done("1"), done("2"), answer]);
  // Stopped before the tool ran, or after only some of the calls were answered.
  assert.deepEqual(repairHistory([user("a"), answer, user("b"), call("1")]), [user("a"), answer, user("b")]);
  assert.deepEqual(repairHistory([user("a"), call("1", "2"), done("1")]), [user("a")]);
  // A tool result whose request is gone (compaction) and everything after it cannot be sent.
  assert.deepEqual(repairHistory([done("9"), user("a")]), []);
  // A stored system message is not part of the history.
  assert.deepEqual(repairHistory([{ role: "system", content: "s" }, user("a")]), [user("a")]);
});

test("session files have safe, distinct names", () => {
  assert.equal(sessionFileName("orchestrator"), "orchestrator.json");
  assert.equal(sessionFileName("t-0001"), "t-0001.json");
  const odd = sessionFileName("../../etc/passwd");
  assert.match(odd, /^[A-Za-z0-9_-]+\.json$/);
  assert.notEqual(sessionFileName("a/b"), sessionFileName("a_b"));
});

test("history survives a broken file and writes atomically", () => {
  const dir = join(tempDir(), "h");
  const history = new SessionHistory(dir, 5);
  assert.deepEqual(history.load("x"), [], "no file yet");
  history.save("x", [{ role: "user", content: "kept" }]);
  assert.deepEqual(history.load("x"), [{ role: "user", content: "kept" }]);
  assert.deepEqual(readdirSync(dir), ["x.json"], "no temporary file is left behind");
  writeFileSync(join(dir, "x.json"), "{not json");
  assert.deepEqual(history.load("x"), [], "an unreadable file is an empty conversation, not a crash");
  history.save("x", [{ role: "user", content: "again" }]);
  history.forget("x");
  assert.deepEqual(history.load("x"), []);

  // A save scheduled while messages are still arriving writes the latest ones, once.
  const live: AgentMessage[] = [{ role: "user", content: "1" }];
  history.schedule("y", () => live);
  live.push({ role: "assistant", content: "2" });
  history.schedule("y", () => live);
  history.flush("y");
  assert.equal(history.load("y").length, 2);
});
