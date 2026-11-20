import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotError, runtimeCapabilities, type RuntimeExecRequest, type RuntimeRunRequest, type RuntimeRunResult } from "@deyin/host-core";
import type { EngineClient } from "../src/main/bots/engine/client.js";
import { LocalBotRuntime, ServerBotRuntime, botRuntimeFor } from "../src/main/bots/engine/runtimes.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "deyin-runtimes-"));
  dirs.push(dir);
  return dir;
}

async function refused(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof BotError && error.code === "invalid" && pattern.test(error.message));
}

/* LocalBotRuntime ---------------------------------------------------------- */

test("a local runtime keeps files in the Bot's folder, which it creates", async () => {
  const root = join(tmp(), "bot", "files");
  const runtime = new LocalBotRuntime({ root });
  assert.equal(runtime.kind, "local");
  assert.equal(runtime.home, root);
  assert.deepEqual(runtime.capabilities, runtimeCapabilities("local"));
  assert.deepEqual(await runtime.health(), { ok: true });
  await runtime.writeFile("notes/today.md", "hello");
  assert.equal(await runtime.readFile("notes/today.md"), "hello");
  const listed = await runtime.listFiles("");
  assert.deepEqual(listed.map((entry) => [entry.path, entry.kind]), [["notes", "directory"]]);
  assert.deepEqual((await runtime.listFiles("notes")).map((entry) => [entry.path, entry.kind, entry.size]), [["notes/today.md", "file", 5]]);
  await runtime.removeFile("notes", { recursive: true });
  assert.deepEqual(await runtime.listFiles(""), []);
});

test("a local runtime refuses a path that leaves the folder, before touching anything", async () => {
  const runtime = new LocalBotRuntime({ root: join(tmp(), "files") });
  await refused(runtime.readFile("../secret"), /go up out of the Bot's folder/);
  await refused(runtime.writeFile("/etc/passwd", "x"), /not absolute/);
  await refused(runtime.listFiles("a/../.."), /go up out of the Bot's folder/);
  await refused(runtime.removeFile("", {}), /./);
  await refused(runtime.readFile("C:\\Windows"), /./);
});

test("a local runtime runs a command in the folder and reports how it ended", async () => {
  const root = join(tmp(), "files");
  const runtime = new LocalBotRuntime({ root });
  await runtime.writeFile("hello.txt", "from a file");
  const ok = await runtime.exec({ command: "cat hello.txt && echo done >&2" } satisfies RuntimeExecRequest);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), "from a file");
  assert.equal(ok.stderr.trim(), "done");
  assert.equal(ok.timedOut, false);
  const failed = await runtime.exec({ command: "exit 3" });
  assert.equal(failed.code, 3);
});

test("a command that runs too long is stopped and says so", async () => {
  const runtime = new LocalBotRuntime({ root: join(tmp(), "files") });
  const result = await runtime.exec({ command: "sleep 5", timeoutMs: 200 });
  assert.equal(result.timedOut, true);
});

test("a local runtime whose folder cannot be made is not healthy, and says why", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "file"), "not a folder");
  const health = await new LocalBotRuntime({ root: join(dir, "file", "inside") }).health();
  assert.equal(health.ok, false);
  assert.match(health.reason ?? "", /^This Bot's folder cannot be used: /);
});

test("a Bot on this computer runs the agent in the app itself, unless the caller wires one in", async () => {
  const runtime = new LocalBotRuntime({ root: join(tmp(), "files") });
  await assert.rejects(() => runtime.run({ prompt: "x", model: "m", mode: "read_only" }, () => undefined), /runs in the app itself/);
  const seen: RuntimeRunRequest[] = [];
  const wired = new LocalBotRuntime({
    root: join(tmp(), "files"),
    runAgent: async (request, onEvent): Promise<RuntimeRunResult> => {
      seen.push(request);
      onEvent("line");
      return { reason: "completed", finalText: "ok" };
    },
  });
  const lines: string[] = [];
  assert.deepEqual(await wired.run({ prompt: "x", model: "m", mode: "read_only" }, (line) => lines.push(line)), { reason: "completed", finalText: "ok" });
  assert.deepEqual(lines, ["line"]);
  assert.equal(seen.length, 1);
});

/* ServerBotRuntime --------------------------------------------------------- */

interface Call {
  method: string;
  args: unknown[];
}

function fakeEngine(over: Partial<Record<keyof EngineClient, unknown>> = {}) {
  const calls: Call[] = [];
  const record = (method: string, result: unknown) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return typeof result === "function" ? (result as (...a: unknown[]) => unknown)(...args) : result;
  };
  const client = {
    health: record("health", { ok: true, version: "1.2.3" }),
    status: record("status", { apiVersion: 1, version: "1.2.3", startedAt: 1, agent: { found: true, signedIn: true }, bots: [], runningNow: 0 }),
    exec: record("exec", { code: 0, stdout: "x", stderr: "", timedOut: false, truncated: false }),
    listFiles: record("listFiles", []),
    readFile: record("readFile", "content"),
    writeFile: record("writeFile", undefined),
    removeFile: record("removeFile", undefined),
    run: record("run", { reason: "completed", finalText: "done" }),
    ...Object.fromEntries(Object.entries(over).map(([key, value]) => [key, record(key, value)])),
  } as unknown as EngineClient;
  return { client, calls, hostsAsked: [] as string[] };
}

function serverRuntime(over: Partial<Record<keyof EngineClient, unknown>> = {}) {
  const fake = fakeEngine(over);
  const runtime = new ServerBotRuntime({
    botId: "bot_1",
    hostId: "host_1",
    links: {
      client: async (hostId) => {
        fake.hostsAsked.push(hostId);
        return fake.client;
      },
    },
  });
  return { runtime, ...fake };
}

test("a server runtime knows where the Bot's files are, for showing a person, and what a server can do", () => {
  const { runtime } = serverRuntime();
  assert.equal(runtime.kind, "server");
  assert.equal(runtime.home, "~/.deyin-bot/bots/bot_1/files");
  assert.deepEqual(runtime.capabilities, runtimeCapabilities("server"));
  assert.equal(runtime.capabilities.scheduler, true);
  assert.equal(runtime.capabilities.browser, false);
});

test("a server runtime passes each file call to its server's engine for this Bot, with a clean path", async () => {
  const t = serverRuntime();
  await t.runtime.listFiles("");
  await t.runtime.listFiles("./notes//deep/");
  assert.equal(await t.runtime.readFile("notes/a.md"), "content");
  await t.runtime.writeFile("notes/a.md", "hi");
  await t.runtime.removeFile("notes", { recursive: true });
  await t.runtime.removeFile("a.md");
  assert.deepEqual(t.calls.map((call) => [call.method, ...call.args.filter((arg) => arg !== undefined)]), [
    ["listFiles", "bot_1", ""],
    ["listFiles", "bot_1", "notes/deep"],
    ["readFile", "bot_1", "notes/a.md"],
    ["writeFile", "bot_1", "notes/a.md", "hi"],
    ["removeFile", "bot_1", "notes", true],
    ["removeFile", "bot_1", "a.md", false],
  ]);
  assert.deepEqual([...new Set(t.hostsAsked)], ["host_1"]);
});

test("a path that leaves the folder is refused here, before the server is asked", async () => {
  const t = serverRuntime();
  await refused(t.runtime.readFile("../x"), /go up out of the Bot's folder/);
  await refused(t.runtime.writeFile("/abs", "x"), /./);
  await refused(t.runtime.listFiles("a/../../b"), /go up out of the Bot's folder/);
  await refused(t.runtime.removeFile("", {}), /./);
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.hostsAsked, [], "the connection is not even opened");
});

test("a command goes to the engine as it is", async () => {
  const t = serverRuntime();
  const result = await t.runtime.exec({ command: "ls", timeoutMs: 5 });
  assert.equal(result.stdout, "x");
  assert.deepEqual(t.calls[0], { method: "exec", args: ["bot_1", { command: "ls", timeoutMs: 5 }, undefined] });
});

test("a run ends the way the engine says, and what went wrong is kept only when something did", async () => {
  const done = serverRuntime();
  const lines: string[] = [];
  assert.deepEqual(await done.runtime.run({ prompt: "p", model: "m", mode: "read_only" }, (line) => lines.push(line)), { reason: "completed", finalText: "done" });
  const failed = serverRuntime({ run: { reason: "failed", finalText: "", error: "no credit" } });
  assert.deepEqual(await failed.runtime.run({ prompt: "p", model: "m", mode: "read_only" }, () => undefined), { reason: "failed", finalText: "", error: "no credit" });
});

test("a server runtime is healthy when its engine answers and its agent is there and signed in", async () => {
  assert.deepEqual(await serverRuntime().runtime.health(), { ok: true, version: "1.2.3" });
});

test("it says what is wrong when the agent is missing, not signed in, or the engine cannot be reached", async () => {
  const agent = (found: boolean, signedIn: boolean) => ({ apiVersion: 1, version: "9.9.9", startedAt: 1, agent: { found, signedIn }, bots: [], runningNow: 0 });
  const missing = await serverRuntime({ status: agent(false, false) }).runtime.health();
  assert.deepEqual([missing.ok, missing.version], [false, "1.2.3"]);
  assert.match(missing.reason ?? "", /could not find deyin on the server/);
  const out = await serverRuntime({ status: agent(true, false) }).runtime.health();
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /not signed in/);
  const down = new ServerBotRuntime({
    botId: "bot_1",
    hostId: "host_1",
    links: {
      client: async () => {
        throw new BotError("conflict", "Could not connect to Dell: timed out");
      },
    },
  });
  assert.deepEqual(await down.health(), { ok: false, reason: "Could not connect to Dell: timed out" });
});

/* botRuntimeFor ------------------------------------------------------------ */

test("a Bot's runtime is the one for the computer it says, and a Bot on a server with none chosen is refused in words", () => {
  const links = { client: async () => fakeEngine().client };
  const local = botRuntimeFor({ id: "bot_1", name: "Ada", harness: "local" }, { filesDir: (id) => `/data/${id}/files`, links });
  assert.equal(local.kind, "local");
  assert.equal(local.home, "/data/bot_1/files");
  const server = botRuntimeFor({ id: "bot_1", name: "Ada", harness: "server", hostId: "host_1" }, { filesDir: () => "/unused", links });
  assert.equal(server.kind, "server");
  assert.throws(
    () => botRuntimeFor({ id: "bot_1", name: "Ada", harness: "server" }, { filesDir: () => "/unused", links }),
    (error: unknown) => error instanceof BotError && error.code === "invalid" && /Ada is set to run on a server, but no server is chosen/.test(error.message),
  );
});

test("a local runtime made for a Bot carries the app's own agent when one is given", async () => {
  const runtime = botRuntimeFor(
    { id: "bot_1", name: "Ada", harness: "local" },
    {
      filesDir: () => join(tmp(), "files"),
      links: { client: async () => fakeEngine().client },
      runLocalAgent: async () => ({ reason: "completed", finalText: "from the app" }),
    },
  );
  assert.equal((await runtime.run({ prompt: "x", model: "m", mode: "read_only" }, () => undefined)).finalText, "from the app");
});
