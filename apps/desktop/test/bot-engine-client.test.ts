import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { startBotEngine, type RunningEngine } from "@deyin/bot-engine";
import { BotError, RUNTIME_LIMITS, type EngineRoutine } from "@deyin/host-core";
import { EngineClient } from "../src/main/bots/engine/client.js";

const FAKE_DEYIN = fileURLToPath(new URL("../../../packages/bot-engine/test/helpers/fake-deyin.mjs", import.meta.url));
const TOKEN = "k".repeat(40);

const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function engine(options: { maxConcurrentRuns?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "deyin-client-"));
  const home = join(root, "home");
  const logDir = join(root, "log");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "token"), TOKEN, { mode: 0o600 });
  const running: RunningEngine = await startBotEngine({
    version: "1.2.3",
    home,
    port: 0,
    deyin: { command: process.execPath, args: [FAKE_DEYIN] },
    engine: { env: { ...process.env, FAKE_LOG_DIR: logDir }, ...options },
  });
  cleanups.push(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });
  const client = new EngineClient({ host: "127.0.0.1", port: running.port, token: TOKEN, label: "Test server" });
  return { client, running, home, logDir, root };
}

async function refused(promise: Promise<unknown>, code: BotError["code"]): Promise<BotError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BotError, `expected a BotError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail("expected the call to be refused");
}

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A server that is not an engine, answering as the test says. */
async function impostor(handler: (url: string) => { status: number; body: string } | "hang"): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    const answer = handler(req.url ?? "/");
    if (answer === "hang") return;
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as { port: number }).port, server };
}

const routine = (over: Partial<EngineRoutine> = {}): EngineRoutine => ({
  id: "r1",
  name: "Morning brief",
  cron: "0 8 * * *",
  prompt: "ECHO hello",
  model: "xai::grok",
  mode: "read_only",
  enabled: true,
  ...over,
});

test("the engine answers its health check, and says what it is", async () => {
  const { client } = await engine();
  assert.deepEqual(await client.health(), { ok: true, apiVersion: 1, version: "1.2.3" });
  const status = await client.status();
  assert.equal(status.apiVersion, 1);
  assert.deepEqual(status.agent, { found: true, version: "9.9.9", signedIn: true });
});

test("a key the engine does not accept is a clear refusal, not a mystery", async () => {
  const { running } = await engine();
  const wrong = new EngineClient({ host: "127.0.0.1", port: running.port, token: "z".repeat(40), label: "Test server" });
  assert.match((await refused(wrong.status(), "conflict")).message, /did not accept the desktop's key/);
  assert.equal((await wrong.health()).ok, true, "health asks for no key");
});

test("files go in and out, and the engine's refusals keep their meaning", async () => {
  const { client } = await engine();
  await client.writeFile("b1", "notes/today.md", "# Today\nπ\n");
  assert.equal(await client.readFile("b1", "notes/today.md"), "# Today\nπ\n");
  assert.deepEqual((await client.listFiles("b1", "")).map((e) => [e.name, e.kind]), [["notes", "directory"]]);
  assert.deepEqual((await client.listFiles("b1", "notes")).map((e) => e.path), ["notes/today.md"]);
  await refused(client.readFile("b1", "missing.md"), "not_found");
  await refused(client.readFile("b1", "../../token"), "invalid");
  await refused(client.writeFile("b1", "/etc/passwd", "x"), "invalid");
  await refused(client.removeFile("b1", "notes", false), "conflict");
  await client.removeFile("b1", "notes", true);
  await refused(client.readFile("b1", "notes/today.md"), "not_found");
  await refused(client.writeFile("b1", "big.txt", "x".repeat(RUNTIME_LIMITS.fileBytes + 1)), "limit");
});

test("a path with spaces, slashes and non-ASCII letters survives the trip", async () => {
  const { client } = await engine();
  await client.writeFile("b1", "my notes/été & more.txt", "ok");
  assert.equal(await client.readFile("b1", "my notes/été & more.txt"), "ok");
  assert.deepEqual((await client.listFiles("b1", "my notes")).map((e) => e.name), ["été & more.txt"]);
});

test("a command's output and exit code come back whole", async () => {
  const { client } = await engine();
  await client.writeFile("b1", "hello.txt", "hi there");
  const result = await client.exec("b1", { command: "cat hello.txt; echo oops 1>&2; exit 3" });
  assert.deepEqual(result, { code: 3, timedOut: false, stdout: "hi there", stderr: "oops\n", truncated: false });
  await refused(client.exec("b1", { command: "ls", cwd: "../.." }), "invalid");
  await refused(client.exec("b1", { command: "ls", cwd: "missing" }), "not_found");
});

test("a command that times out says so", async () => {
  const { client } = await engine();
  const result = await client.exec("b1", { command: "sleep 30", timeoutMs: 1_000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
});

test("stopping a command stops it on the server and gives back what it printed", async () => {
  const { client, home } = await engine();
  const controller = new AbortController();
  const pending = client.exec("b1", { command: "echo started; echo $$ > pid; sleep 30" }, controller.signal);
  const pidFile = join(home, "bots", "b1", "files", "pid");
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the command to start");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  controller.abort();
  const result = await pending;
  assert.equal(result.code, null);
  assert.equal(result.stdout, "started\n", "what it had printed is not lost");
  await until(() => !alive(pid), "the command to be stopped on the server");
});

test("a call that is stopped before it starts never reaches the engine", async () => {
  const { client, home } = await engine();
  const controller = new AbortController();
  controller.abort();
  await refused(client.writeFile("b1", "a.txt", "x", controller.signal), "conflict");
  assert.deepEqual(await client.exec("b1", { command: "touch started" }, controller.signal), { code: null, timedOut: false, stdout: "", stderr: "", truncated: false });
  const outcome = await client.run("b1", { prompt: "ECHO", model: "m", mode: "read_only" }, () => undefined, controller.signal);
  assert.equal(outcome.reason, "aborted");
  assert.equal(existsSync(join(home, "bots", "b1")), false, "nothing reached the engine");
});

test("an agent run hands on every line and says how it ended", async () => {
  const { client } = await engine();
  const lines: string[] = [];
  const outcome = await client.run("b1", { prompt: "ECHO hi", model: "xai::grok", mode: "read_only" }, (line) => lines.push(line));
  assert.deepEqual(lines, ['{"type":"text-delta","delta":"thinking"}', '{"type":"result","finalText":"echo: ECHO hi","reason":"completed"}']);
  assert.equal(outcome.reason, "completed");
  assert.equal(outcome.finalText, "echo: ECHO hi");
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.end, { type: "engine-exit", code: 0, timedOut: false, aborted: false });
});

test("an agent run that stops at its step limit says so", async () => {
  const { client } = await engine();
  const outcome = await client.run("b1", { prompt: "STEPS", model: "m", mode: "read_only" }, () => undefined);
  assert.equal(outcome.reason, "max-steps");
  assert.equal(outcome.finalText, "partial");
});

test("an agent run that fails says why; one that is not signed in says to sign in", async () => {
  const { client } = await engine();
  const failed = await client.run("b1", { prompt: "FAIL", model: "m", mode: "read_only" }, () => undefined);
  assert.equal(failed.reason, "failed");
  assert.match(failed.error ?? "", /exit code 1.*boom happened/);
  const auth = await client.run("b1", { prompt: "AUTH", model: "m", mode: "read_only" }, () => undefined);
  assert.equal(auth.reason, "failed");
  assert.match(auth.error ?? "", /not signed in/);
});

test("an agent run past its limit is a timeout", async () => {
  const { client } = await engine();
  const outcome = await client.run("b1", { prompt: "SLEEP", model: "m", mode: "read_only", timeoutMs: 1_000 }, () => undefined);
  assert.equal(outcome.reason, "timeout");
  assert.equal(outcome.error, undefined, "a timeout is not reported as a failure");
  assert.equal(outcome.end.timedOut, true);
});

test("stopping an agent run stops the agent on the server", async () => {
  const { client, logDir } = await engine();
  const controller = new AbortController();
  const lines: string[] = [];
  const pending = client.run("b1", { prompt: "SLEEP", model: "m", mode: "read_only" }, (l) => lines.push(l), controller.signal);
  const pidFile = join(logDir, "sleeping.pid");
  await until(() => existsSync(pidFile), "the agent to start");
  const pid = Number(readFileSync(pidFile, "utf8"));
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.reason, "aborted");
  assert.equal(outcome.end.aborted, true);
  await until(() => !alive(pid), "the agent to be stopped on the server");
});

test("a busy server turns a run away with a message a person can read", async () => {
  const { client, logDir } = await engine({ maxConcurrentRuns: 1 });
  const controller = new AbortController();
  const first = client.run("b1", { prompt: "SLEEP", model: "m", mode: "read_only" }, () => undefined, controller.signal);
  await until(() => existsSync(join(logDir, "sleeping.pid")), "the first run to start");
  const error = await refused(client.run("b2", { prompt: "ECHO", model: "m", mode: "read_only" }, () => undefined), "limit");
  assert.match(error.message, /already running 1 thing/);
  controller.abort();
  await first;
});

test("a run request the engine will not take is refused before anything runs", async () => {
  const { client, logDir } = await engine();
  await refused(client.run("b1", { prompt: "x", model: "m", mode: "auto_review" as never }, () => undefined), "invalid");
  assert.equal(existsSync(logDir), false, "no agent was started");
});

test("routines are kept, listed, run by hand, and removed", async () => {
  const { client, running } = await engine();
  const saved = await client.saveRoutine("b1", routine());
  assert.equal(saved.id, "r1");
  assert.ok(saved.nextRunAt && saved.nextRunAt > Date.now());
  assert.deepEqual((await client.routines("b1")).map((r) => r.id), ["r1"]);

  const started = await client.runRoutineNow("b1", "r1");
  assert.equal(started.status, "running");
  await running.engine.idle();
  const runs = await client.routineRuns("b1", "r1");
  assert.equal(runs[0]?.id, started.id);
  assert.equal(runs[0]?.status, "completed");
  assert.equal(runs[0]?.finalText, "echo: ECHO hello");

  assert.equal(await client.removeRoutine("b1", "r1"), true);
  assert.equal(await client.removeRoutine("b1", "r1"), false);
  assert.deepEqual(await client.routines("b1"), []);
  await refused(client.runRoutineNow("b1", "r1"), "not_found");
});

test("a schedule the engine will not run is refused with its reason", async () => {
  const { client } = await engine();
  assert.match((await refused(client.saveRoutine("b1", routine({ cron: "* * * * *" })), "invalid")).message, /once every 5 minutes/);
  assert.match((await refused(client.saveRoutine("b1", routine({ cron: "nonsense" })), "invalid")).message, /does not parse/);
  assert.deepEqual(await client.routines("b1"), []);
});

test("removing a Bot removes everything the server kept for it", async () => {
  const { client, home } = await engine();
  await client.writeFile("b1", "a.txt", "x");
  await client.saveRoutine("b1", routine());
  assert.equal(await client.removeBot("b1"), true);
  assert.equal(existsSync(join(home, "bots", "b1")), false);
  assert.equal(await client.removeBot("b1"), false);
});

test("a server that is not there is a clear message naming it", async () => {
  const { running } = await engine();
  const port = running.port;
  await running.close();
  const client = new EngineClient({ host: "127.0.0.1", port, token: TOKEN, label: "Test server" });
  const error = await refused(client.status(), "conflict");
  assert.match(error.message, /Could not reach the Bot engine on Test server/);
  await refused(client.health(), "conflict");
  await refused(client.exec("b1", { command: "ls" }), "conflict");
  await refused(client.run("b1", { prompt: "x", model: "m", mode: "read_only" }, () => undefined), "conflict");
});

test("something on the port that is not an engine is not mistaken for one", async () => {
  const { port } = await impostor(() => ({ status: 200, body: JSON.stringify({ hello: "world" }) }));
  const client = new EngineClient({ host: "127.0.0.1", port, token: TOKEN, label: "Odd server" });
  assert.match((await refused(client.health(), "conflict")).message, /not a Bot engine/);
  const html = await impostor(() => ({ status: 200, body: "<html>nginx</html>" }));
  const second = new EngineClient({ host: "127.0.0.1", port: html.port, token: TOKEN, label: "Odd server" });
  assert.match((await refused(second.health(), "conflict")).message, /not a Bot engine/);
  assert.match((await refused(second.status(), "conflict")).message, /does not understand/);
});

test("an engine that sends the wrong shape is refused, not trusted", async () => {
  const wrong = await impostor((url) => {
    if (url.includes("routines")) return { status: 200, body: JSON.stringify({ routines: "nope", runs: 5, run: { id: 1 } }) };
    if (url.includes("files")) return { status: 200, body: JSON.stringify({ entries: "nope", content: 5 }) };
    return { status: 200, body: "{}" };
  });
  const client = new EngineClient({ host: "127.0.0.1", port: wrong.port, token: TOKEN, label: "Odd server" });
  await refused(client.routines("b1"), "conflict");
  await refused(client.routineRuns("b1", "r1"), "conflict");
  await refused(client.runRoutineNow("b1", "r1"), "conflict");
  await refused(client.listFiles("b1", ""), "conflict");
  await refused(client.readFile("b1", "a.txt"), "conflict");
  await refused(client.saveRoutine("b1", routine()), "conflict");
});

test("an engine that errors without a body, or with garbage, still gives a readable refusal", async () => {
  const broken = await impostor(() => ({ status: 502, body: "<html>Bad gateway</html>" }));
  const client = new EngineClient({ host: "127.0.0.1", port: broken.port, token: TOKEN, label: "Odd server" });
  assert.match((await refused(client.status(), "conflict")).message, /status 502/);
  await refused(client.run("b1", { prompt: "x", model: "m", mode: "read_only" }, () => undefined), "conflict");
});

test("a server that never answers is given up on, with its name", async () => {
  const silent = await impostor(() => "hang");
  const client = new EngineClient({ host: "127.0.0.1", port: silent.port, token: TOKEN, label: "Slow server", callTimeoutMs: 200 });
  const started = Date.now();
  assert.match((await refused(client.status(), "conflict")).message, /Slow server did not answer in time/);
  assert.ok(Date.now() - started < 5_000);
});

test("a connection that drops in the middle of a run is reported, not treated as done", async () => {
  const dropper = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write('{"type":"text-delta","delta":"half"}\n');
    setTimeout(() => res.destroy(), 50);
  });
  await new Promise<void>((resolve) => dropper.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(async () => {
    dropper.closeAllConnections();
    await new Promise<void>((resolve) => dropper.close(() => resolve()));
  });
  const client = new EngineClient({ host: "127.0.0.1", port: (dropper.address() as { port: number }).port, token: TOKEN, label: "Flaky server" });
  const lines: string[] = [];
  await refused(client.run("b1", { prompt: "x", model: "m", mode: "read_only" }, (l) => lines.push(l)), "conflict");
  assert.deepEqual(lines, ['{"type":"text-delta","delta":"half"}'], "what arrived before the drop was handed on");
  await refused(client.exec("b1", { command: "ls" }), "conflict");
});

test("a connection the engine closes cleanly without saying how it ended is reported, not treated as done", async () => {
  const quitter = await impostor(() => "hang");
  quitter.server.removeAllListeners("request");
  quitter.server.on("request", (_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end('{"type":"text-delta","delta":"half"}\n');
  });
  const client = new EngineClient({ host: "127.0.0.1", port: quitter.port, token: TOKEN, label: "Flaky server" });
  const message = (await refused(client.run("b1", { prompt: "x", model: "m", mode: "read_only" }, () => undefined), "conflict")).message;
  assert.match(message, /Flaky server dropped before the Bot finished/);
  assert.match((await refused(client.exec("b1", { command: "ls" }), "conflict")).message, /Flaky server dropped before the command finished/);
});

test("run records the engine sends that this app does not know are left out, the rest kept", async () => {
  const good = { id: "run1", routineId: "r1", startedAt: 5, status: "completed", trigger: "manual" };
  const mixed = await impostor(() => ({
    status: 200,
    body: JSON.stringify({ runs: [good, null, "x", { ...good, id: "run2", status: "exploded" }, { ...good, id: 3 }, { ...good, id: "run4", trigger: "dream" }, { ...good, id: "run5", startedAt: "now" }] }),
  }));
  const client = new EngineClient({ host: "127.0.0.1", port: mixed.port, token: TOKEN, label: "Odd server" });
  assert.deepEqual(await client.routineRuns("b1", "r1"), [good]);
});
