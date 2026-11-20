import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENGINE_PATHS,
  ExecCollector,
  LineSplitter,
  engineErrorFrom,
  engineErrorStatus,
  isEngineHealth,
  isEngineRunRecord,
  parseAgentResultLine,
  parseExecLine,
  parseRunEnd,
  runFailureMessage,
  runReasonFrom,
} from "../src/bots/engine-protocol.js";
import {
  RUNTIME_LIMITS,
  cleanRelativePath,
  clipOutput,
  execTimeout,
  isValidRoutineId,
  isValidRuntimeBotId,
  parseEngineRoutine,
  parseExecRequest,
  parseRunRequest,
  runModeForApproval,
  runTimeout,
  runtimeCapabilities,
} from "../src/bots/runtime.js";
import { BotError } from "../src/bots/types.js";

function refused(fn: () => unknown, code: BotError["code"] = "invalid"): BotError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BotError, `expected a BotError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail("expected the call to be refused");
}

test("a path is cleaned to the part inside the Bot's folder", () => {
  assert.equal(cleanRelativePath("notes/today.md"), "notes/today.md");
  assert.equal(cleanRelativePath("./notes//today.md"), "notes/today.md");
  assert.equal(cleanRelativePath("notes/./sub/"), "notes/sub");
  assert.equal(cleanRelativePath("a b/ünïcode.txt"), "a b/ünïcode.txt");
  assert.equal(cleanRelativePath("", { allowRoot: true }), "");
  assert.equal(cleanRelativePath(".", { allowRoot: true }), "");
});

test("a path that leaves the folder, or is not plain text, is refused", () => {
  for (const bad of ["../x", "a/../../x", "a/..", "..", "/", "/etc/passwd", "C:\\Windows", "c:/x", "a\\b", "a\u0000b", "a\nb", "a\u007fb"]) {
    refused(() => cleanRelativePath(bad, { allowRoot: true }));
  }
  refused(() => cleanRelativePath("", {}));
  refused(() => cleanRelativePath("."));
  refused(() => cleanRelativePath(42));
  refused(() => cleanRelativePath(null));
  refused(() => cleanRelativePath("a/".repeat(RUNTIME_LIMITS.pathLength)));
});

test("ids a URL carries are plain: letters, digits, dash and underscore", () => {
  assert.equal(isValidRuntimeBotId("bot_0123456789abcdef"), true);
  assert.equal(isValidRuntimeBotId("a"), true);
  for (const bad of ["", "-a", "_a", "a/b", "a b", "../x", "a.b", "é", "a".repeat(65), 7, undefined]) {
    assert.equal(isValidRuntimeBotId(bad), false, String(bad));
  }
  assert.equal(isValidRoutineId("r1"), true);
  assert.equal(isValidRoutineId("r/1"), false);
});

test("a command request keeps what it needs and refuses what it should", () => {
  assert.deepEqual(parseExecRequest({ command: "ls -la" }), { command: "ls -la" });
  assert.deepEqual(parseExecRequest({ command: "ls", cwd: "./sub/", timeoutMs: 5_000 }), { command: "ls", cwd: "sub", timeoutMs: 5_000 });
  assert.deepEqual(parseExecRequest({ command: "ls", cwd: "" }), { command: "ls" }, "an empty folder is the Bot's folder");
  refused(() => parseExecRequest(null));
  refused(() => parseExecRequest({}));
  refused(() => parseExecRequest({ command: "   " }));
  refused(() => parseExecRequest({ command: 5 }));
  refused(() => parseExecRequest({ command: "x".repeat(RUNTIME_LIMITS.commandLength + 1) }));
  refused(() => parseExecRequest({ command: "a\u0000b" }));
  refused(() => parseExecRequest({ command: "ls", cwd: "../.." }));
  refused(() => parseExecRequest({ command: "ls", timeoutMs: 10 }), "invalid");
  refused(() => parseExecRequest({ command: "ls", timeoutMs: RUNTIME_LIMITS.execTimeoutMaxMs + 1 }));
  refused(() => parseExecRequest({ command: "ls", timeoutMs: 1.5 }));
});

test("a run request needs a prompt, a model and an explicit mode", () => {
  const ok = { prompt: "do it", model: "xai::grok", mode: "read_only" };
  assert.deepEqual(parseRunRequest(ok), ok);
  assert.deepEqual(parseRunRequest({ ...ok, maxSteps: 12, timeoutMs: 60_000 }), { ...ok, maxSteps: 12, timeoutMs: 60_000 });
  refused(() => parseRunRequest({ ...ok, mode: undefined }));
  refused(() => parseRunRequest({ ...ok, mode: "auto_review" }), "invalid");
  refused(() => parseRunRequest({ ...ok, mode: "RUN_EVERYTHING" }));
  refused(() => parseRunRequest({ ...ok, prompt: "" }));
  refused(() => parseRunRequest({ ...ok, prompt: "x".repeat(RUNTIME_LIMITS.promptLength + 1) }));
  refused(() => parseRunRequest({ ...ok, model: "two words" }));
  refused(() => parseRunRequest({ ...ok, model: "" }));
  refused(() => parseRunRequest({ ...ok, maxSteps: 0 }));
  refused(() => parseRunRequest({ ...ok, maxSteps: 1001 }));
  refused(() => parseRunRequest({ ...ok, timeoutMs: RUNTIME_LIMITS.runTimeoutMaxMs + 1 }));
  refused(() => parseRunRequest([]));
});

test("a routine is checked in shape, with its id from the URL and not from the body", () => {
  const body = { name: "  Morning brief ", cron: " 0 8 * * * ", prompt: "Summarise", model: "m", mode: "read_only", enabled: true };
  assert.deepEqual(parseEngineRoutine({ ...body, id: "ignored" }, "r1"), {
    id: "r1",
    name: "Morning brief",
    cron: "0 8 * * *",
    prompt: "Summarise",
    model: "m",
    mode: "read_only",
    enabled: true,
  });
  refused(() => parseEngineRoutine(body, "../r"));
  refused(() => parseEngineRoutine({ ...body, name: "" }, "r1"));
  refused(() => parseEngineRoutine({ ...body, name: "x".repeat(RUNTIME_LIMITS.routineName + 1) }, "r1"));
  refused(() => parseEngineRoutine({ ...body, cron: "0 8 *\n* *" }, "r1"));
  refused(() => parseEngineRoutine({ ...body, cron: "x".repeat(RUNTIME_LIMITS.cronLength + 1) }, "r1"));
  refused(() => parseEngineRoutine({ ...body, enabled: "yes" }, "r1"));
  refused(() => parseEngineRoutine({ ...body, enabled: undefined }, "r1"));
  refused(() => parseEngineRoutine({ ...body, mode: "auto_review" }, "r1"));
  refused(() => parseEngineRoutine({ ...body, timeoutMs: 5 }, "r1"));
  refused(() => parseEngineRoutine("nope", "r1"));
});

test("timeouts never exceed their ceilings", () => {
  assert.equal(execTimeout({}), RUNTIME_LIMITS.execTimeoutMs);
  assert.equal(execTimeout({ timeoutMs: 1_000 }), 1_000);
  assert.equal(execTimeout({ timeoutMs: 10 ** 9 }), RUNTIME_LIMITS.execTimeoutMaxMs);
  assert.equal(runTimeout({}), RUNTIME_LIMITS.runTimeoutMs);
  assert.equal(runTimeout({ timeoutMs: 10 ** 12 }), RUNTIME_LIMITS.runTimeoutMaxMs);
});

test("output is cut at a byte limit, on a whole character", () => {
  assert.deepEqual(clipOutput("hello", 10), { text: "hello", truncated: false });
  assert.deepEqual(clipOutput("hello world", 5), { text: "hello", truncated: true });
  const cut = clipOutput("é".repeat(10), 5);
  assert.equal(cut.text, "éé", "each é is two bytes, so five bytes holds two");
  assert.equal(cut.truncated, true);
  const emoji = clipOutput("😀😀😀", 5);
  assert.equal(emoji.text, "😀", "four bytes fit, the next would split");
  assert.equal(new TextEncoder().encode(emoji.text).length <= 5, true);
  const roomForALoneHalf = clipOutput("😀😀😀", 7);
  assert.equal(roomForALoneHalf.text, "😀", "a lone half of a pair is not kept just because it fits");
  assert.equal(/[\ud800-\udbff]$/.test(roomForALoneHalf.text), false);
  assert.deepEqual(clipOutput("", 0), { text: "", truncated: false });
  assert.deepEqual(clipOutput("a", 0), { text: "", truncated: true });
});

test("a server does not claim a browser, and keeps routines running; this machine does not keep them while closed", () => {
  const server = runtimeCapabilities("server");
  assert.equal(server.scheduler, true);
  assert.equal(server.browser, false);
  const local = runtimeCapabilities("local");
  assert.equal(local.scheduler, false);
  assert.equal(local.browser, true);
  assert.equal(local.exec && local.files && local.agent, true);
  assert.equal(server.exec && server.files && server.agent, true);
});

test("URL paths encode ids so one cannot climb out of its place", () => {
  assert.equal(ENGINE_PATHS.exec("bot_1"), "/v1/bots/bot_1/exec");
  assert.equal(ENGINE_PATHS.exec("a/b"), "/v1/bots/a%2Fb/exec");
  assert.equal(ENGINE_PATHS.routineRun("b", "../x"), "/v1/bots/b/routines/..%2Fx/run");
});

test("error codes and statuses go both ways", () => {
  assert.equal(engineErrorStatus("unauthorized"), 401);
  assert.equal(engineErrorStatus("invalid"), 400);
  assert.equal(engineErrorStatus("not_found"), 404);
  assert.equal(engineErrorStatus("conflict"), 409);
  assert.equal(engineErrorStatus("limit"), 429);
  assert.equal(engineErrorStatus("internal"), 500);
  assert.equal(engineErrorFrom(400, { error: "Bad", code: "invalid" }).code, "invalid");
  assert.equal(engineErrorFrom(404, { error: "No such file", code: "not_found" }).message, "No such file");
  assert.equal(engineErrorFrom(429, { error: "Too many", code: "limit" }).code, "limit");
  assert.equal(engineErrorFrom(500, { error: "boom", code: "internal" }).code, "conflict");
  assert.match(engineErrorFrom(401, { error: "x", code: "unauthorized" }).message, /Reinstall the engine/);
  assert.match(engineErrorFrom(502, "<html>").message, /status 502/);
  assert.match(engineErrorFrom(500, null).message, /status 500/);
});

test("lines come back together however the chunks fall", () => {
  const whole = '{"a":1}\n{"b":2}\n{"c":3}\n';
  for (let size = 1; size <= whole.length; size++) {
    const splitter = new LineSplitter();
    const lines: string[] = [];
    for (let i = 0; i < whole.length; i += size) lines.push(...splitter.push(whole.slice(i, i + size)));
    lines.push(...splitter.end());
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}'], `chunk size ${size}`);
  }
  const splitter = new LineSplitter();
  assert.deepEqual(splitter.push("one\r\n\r\ntwo"), ["one"]);
  assert.deepEqual(splitter.end(), ["two"], "a last line without a newline is not lost");
  assert.deepEqual(splitter.end(), [], "and is only given once");
});

test("exec lines and the run end are recognised, and nothing else is", () => {
  assert.deepEqual(parseExecLine('{"type":"stdout","data":"hi"}'), { type: "stdout", data: "hi" });
  assert.deepEqual(parseExecLine('{"type":"exit","code":0,"timedOut":false}'), { type: "exit", code: 0, timedOut: false });
  assert.deepEqual(parseExecLine('{"type":"exit","code":null,"timedOut":true}'), { type: "exit", code: null, timedOut: true });
  assert.equal(parseExecLine('{"type":"stdout","data":5}'), null);
  assert.equal(parseExecLine('{"type":"exit","code":"0","timedOut":false}'), null);
  assert.equal(parseExecLine("not json"), null);
  assert.equal(parseExecLine("null"), null);

  assert.deepEqual(parseRunEnd('{"type":"engine-exit","code":0,"timedOut":false,"aborted":false}'), {
    type: "engine-exit",
    code: 0,
    timedOut: false,
    aborted: false,
  });
  assert.equal(parseRunEnd('{"type":"engine-exit","code":null,"error":"no deyin"}')?.error, "no deyin");
  assert.equal(parseRunEnd('{"type":"engine-exit","code":1,"stderr":"boom"}')?.stderr, "boom");
  assert.equal("stderr" in parseRunEnd('{"type":"engine-exit","code":1,"stderr":5}')!, false, "a stderr that is not text is dropped");
  assert.equal(parseRunEnd('{"type":"text","text":"engine-exit"}'), null, "a line the agent printed is not the end");
  assert.equal(parseRunEnd('{"type":"engine-exit","code":"1"}'), null);
  assert.equal(parseRunEnd("garbage"), null);
});

test("a command's output is gathered, bounded, and incomplete until it exits", () => {
  const c = new ExecCollector(10);
  assert.equal(c.finish(), null);
  c.add({ type: "stdout", data: "hello " });
  c.add({ type: "stderr", data: "warn" });
  c.add({ type: "stdout", data: "world and more" });
  c.add({ type: "stdout", data: "ignored" });
  assert.equal(c.finish(), null, "no exit line yet");
  c.add({ type: "exit", code: 3, timedOut: false });
  assert.deepEqual(c.finish(), { code: 3, timedOut: false, stdout: "hello worl", stderr: "warn", truncated: true });

  const small = new ExecCollector(100);
  small.add({ type: "stdout", data: "ok\n" });
  small.add({ type: "exit", code: 0, timedOut: false });
  assert.deepEqual(small.finish(), { code: 0, timedOut: false, stdout: "ok\n", stderr: "", truncated: false });

  const wide = new ExecCollector(5);
  wide.add({ type: "stdout", data: "ééé" });
  wide.add({ type: "exit", code: 0, timedOut: false });
  assert.equal(wide.finish()?.stdout, "éé", "never cuts a character in half");

  const empty = new ExecCollector(3);
  empty.add({ type: "stdout", data: "abc" });
  empty.add({ type: "stdout", data: "" });
  empty.add({ type: "exit", code: 0, timedOut: false });
  assert.equal(empty.finish()?.truncated, false, "an empty chunk after a full stream cuts nothing");
});

test("an engine and a run record are told apart from lookalikes", () => {
  assert.equal(isEngineHealth({ ok: true, apiVersion: 1, version: "0.1.0" }), true);
  assert.equal(isEngineHealth({ ok: true }), false);
  assert.equal(isEngineHealth({ ok: false, apiVersion: 1, version: "x" }), false);
  assert.equal(isEngineHealth(null), false);
  const run = { id: "x", routineId: "r", startedAt: 1, status: "completed", trigger: "schedule" };
  assert.equal(isEngineRunRecord(run), true);
  assert.equal(isEngineRunRecord({ ...run, status: "exploded" }), false);
  assert.equal(isEngineRunRecord({ ...run, trigger: "other" }), false);
  assert.equal(isEngineRunRecord({ ...run, startedAt: "1" }), false);
  assert.equal(isEngineRunRecord(undefined), false);
});

test("a command stopped early still shows what it had printed", () => {
  const c = new ExecCollector(100);
  c.add({ type: "stdout", data: "so far" });
  c.add({ type: "stderr", data: "warn" });
  assert.deepEqual(c.partial(), { code: null, timedOut: false, stdout: "so far", stderr: "warn", truncated: false });
  assert.equal(c.finish(), null, "partial is not the end");
});

test("the agent's result line is read, and nothing else is taken for it", () => {
  assert.deepEqual(parseAgentResultLine('{"type":"result","finalText":"done","reason":"completed"}'), { finalText: "done", reason: "completed" });
  assert.deepEqual(parseAgentResultLine('{"type":"result"}'), { finalText: "", reason: "" });
  assert.deepEqual(parseAgentResultLine('{"type":"result","finalText":5,"reason":null}'), { finalText: "", reason: "" });
  assert.equal(parseAgentResultLine('{"type":"text-delta","delta":"result"}'), undefined);
  assert.equal(parseAgentResultLine("null"), undefined);
  assert.equal(parseAgentResultLine("result"), undefined);
});

test("how a run ended comes from the process first and the agent's word second", () => {
  const ok = { timedOut: false, aborted: false };
  assert.equal(runReasonFrom(ok, "completed"), "completed");
  assert.equal(runReasonFrom(ok, "max-steps"), "max-steps");
  assert.equal(runReasonFrom(ok, "aborted"), "aborted");
  assert.equal(runReasonFrom(ok, ""), "failed", "no result line is a failure, whatever the exit code");
  assert.equal(runReasonFrom(ok, "something-new"), "failed");
  assert.equal(runReasonFrom({ ...ok, timedOut: true }, "completed"), "timeout", "a run that was killed at its limit did not complete");
  assert.equal(runReasonFrom({ ...ok, aborted: true }, "completed"), "aborted");
  assert.equal(runReasonFrom({ ...ok, error: "no deyin" }, "completed"), "failed");
  assert.equal(runReasonFrom({ timedOut: true, aborted: true }, ""), "timeout", "time out wins over a stop");
});

test("a failed run is explained in words a person can act on", () => {
  const base = { code: 1, timedOut: false, aborted: false };
  assert.equal(runFailureMessage({ ...base, error: "Could not start deyin: nope" }), "Could not start deyin: nope");
  assert.match(runFailureMessage({ ...base, timedOut: true }), /time limit/);
  assert.match(runFailureMessage({ ...base, aborted: true }), /was stopped/);
  assert.match(runFailureMessage({ ...base, code: 2 }), /not signed in.*Servers page/);
  assert.equal(runFailureMessage({ ...base, stderr: "  boom  " }), "The agent stopped with exit code 1. boom");
  assert.equal(runFailureMessage({ ...base, code: null }), "The agent stopped with exit code unknown.");
  assert.ok(runFailureMessage({ ...base, stderr: "x".repeat(5_000) }).length < 500, "a long stderr is cut");
});

test("a server cannot ask or review, so only run-everything runs everything; Auto Review runs read-only", () => {
  assert.equal(runModeForApproval("run_everything"), "run_everything");
  assert.equal(runModeForApproval("read_only"), "read_only");
  assert.equal(runModeForApproval("auto_review"), "read_only");
});
