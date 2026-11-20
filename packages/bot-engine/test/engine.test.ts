import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  ENGINE_PATHS,
  ExecCollector,
  RUNTIME_LIMITS,
  parseExecLine,
  parseRunEnd,
  type EngineExecLine,
  type EngineRoutineView,
  type EngineRunRecord,
  type EngineStatus,
} from "@deyin/host-core";
import { agentArguments, resolveDeyinCommand } from "../src/agent-run.js";
import type { JobFactory } from "../src/cron.js";
import { startBotEngine, readEngineToken, type RunningEngine, type StartEngineOptions } from "../src/index.js";
import { bearerMatches, createEngineServer } from "../src/server.js";
import { EngineStore } from "../src/store.js";
import { BotEngine } from "../src/engine.js";

const FAKE_DEYIN = fileURLToPath(new URL("./helpers/fake-deyin.mjs", import.meta.url));
const TOKEN = "t".repeat(40);

const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

interface Harness {
  running: RunningEngine;
  base: string;
  home: string;
  logDir: string;
  filesDir(botId: string): string;
  /** A JSON call. */
  call(method: string, path: string, body?: unknown, token?: string | null): Promise<{ status: number; body: any }>;
  /** A call whose answer is lines. */
  lines(method: string, path: string, body: unknown): Promise<{ status: number; lines: string[] }>;
  /** What the fake agent was started with, one entry per run. */
  agentRuns(): Array<{ argv: string[]; cwd: string; pid: number; stdin: string }>;
}

async function harness(options: { home?: string; engine?: StartEngineOptions["engine"]; signedOut?: boolean } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "deyin-engine-"));
  const home = options.home ?? join(root, "home");
  const logDir = join(root, "log");
  mkdirSync(home, { recursive: true });
  if (!existsSync(join(home, "token"))) writeFileSync(join(home, "token"), TOKEN, { mode: 0o600 });
  const running = await startBotEngine({ version: "1.2.3",
    home,
    port: 0,
    deyin: { command: process.execPath, args: [FAKE_DEYIN] },
    engine: {
      env: { ...process.env, FAKE_LOG_DIR: logDir, ...(options.signedOut ? { FAKE_SIGNED_OUT: "1" } : {}) },
      ...options.engine,
    },
  });
  cleanups.push(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${running.port}`;
  return {
    running,
    base,
    home,
    logDir,
    filesDir: (botId) => join(home, "bots", botId, "files"),
    async call(method, path, body, token = TOKEN) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON; the test looks at the text.
      }
      return { status: res.status, body: parsed };
    },
    async lines(method, path, body) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.status !== 200) return { status: res.status, lines: [text] };
      return { status: res.status, lines: text.split("\n").filter(Boolean) };
    },
    agentRuns() {
      if (!existsSync(logDir)) return [];
      return readdirSync(logDir)
        .filter((n) => /^run-\d+\.json$/.test(n))
        .sort()
        .map((n) => JSON.parse(readFileSync(join(logDir, n), "utf8")));
    },
  };
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

function fakeJobs() {
  const jobs: Array<{ expression: string; tick: () => void; stopped: boolean }> = [];
  const factory: JobFactory = (expression, tick) => {
    const job = { expression, tick, stopped: false };
    jobs.push(job);
    return {
      nextRunAt: () => 4_102_444_800_000,
      stop: () => {
        job.stopped = true;
      },
    };
  };
  return { factory, all: jobs, live: () => jobs.filter((j) => !j.stopped) };
}

const routineBody = (over: Record<string, unknown> = {}) => ({
  name: "Morning brief",
  cron: "0 8 * * *",
  prompt: "ECHO hello",
  model: "xai::grok",
  mode: "read_only",
  enabled: true,
  ...over,
});

/* Gate: who may call ---------------------------------------------------------- */

test("health answers anyone; everything else needs the key", async () => {
  const h = await harness();
  const health = await h.call("GET", "/health", undefined, null);
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.body).sort(), ["apiVersion", "ok", "version"], "health says nothing about the Bots");
  for (const [method, path] of [
    ["GET", "/v1/status"],
    ["GET", "/v1/bots/b1/files/list"],
    ["GET", "/v1/bots/b1/routines"],
    ["POST", "/v1/bots/b1/exec"],
    ["POST", "/v1/bots/b1/run"],
    ["DELETE", "/v1/bots/b1"],
  ] as const) {
    assert.equal((await h.call(method, path, method === "POST" ? {} : undefined, null)).status, 401, `${method} ${path} with no key`);
    assert.equal((await h.call(method, path, method === "POST" ? {} : undefined, "x".repeat(40))).status, 401, `${method} ${path} with a wrong key`);
  }
  assert.equal(existsSync(join(h.home, "bots", "b1")), false, "a refused call made nothing");
});

test("the key is compared exactly, in any length", () => {
  assert.equal(bearerMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerMatches(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(bearerMatches(`Bearer ${TOKEN.slice(1)}`, TOKEN), false);
  assert.equal(bearerMatches(TOKEN, TOKEN), false, "no Bearer prefix");
  assert.equal(bearerMatches(`bearer ${TOKEN}`, TOKEN), false);
  assert.equal(bearerMatches(undefined, TOKEN), false);
  assert.equal(bearerMatches("Bearer ", TOKEN), false);
});

test("a key that is too short, missing, or readable by others is refused before anything listens", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-engine-key-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => readEngineToken(join(dir, "nope")), /no key at/);
  const file = join(dir, "token");
  writeFileSync(file, "short", { mode: 0o600 });
  assert.throws(() => readEngineToken(file), /too short/);
  writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
  assert.equal(readEngineToken(file), TOKEN, "a trailing newline is not part of the key");
  chmodSync(file, 0o644);
  assert.throws(() => readEngineToken(file), /chmod 600/);
  chmodSync(file, 0o640);
  assert.throws(() => readEngineToken(file), /chmod 600/);
  const store = new EngineStore(join(dir, "h"));
  assert.throws(() => createEngineServer({ engine: new BotEngine({ store, deyin: { command: "x", args: [] }, version: "1" }), token: "short", version: "1" }), /at least 32/);
});

test("the engine listens on the loopback only", async () => {
  const h = await harness();
  const address = h.running.server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
});

/* Status ---------------------------------------------------------------------- */

test("status says how the engine and the agent on the server are", async () => {
  const h = await harness();
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody());
  const { status, body } = await h.call("GET", ENGINE_PATHS.status);
  assert.equal(status, 200);
  const s = body as EngineStatus;
  assert.equal(s.apiVersion, 1);
  assert.deepEqual(s.agent, { found: true, version: "9.9.9", signedIn: true });
  assert.deepEqual(s.bots, [{ botId: "b1", routines: 1, running: 0 }]);
  assert.equal(s.runningNow, 0);
  assert.equal(typeof s.startedAt, "number");
});

test("status says when the agent is not signed in, and when it is not there at all", async () => {
  const signedOut = await harness({ signedOut: true });
  assert.deepEqual(((await signedOut.call("GET", ENGINE_PATHS.status)).body as EngineStatus).agent, { found: true, version: "9.9.9", signedIn: false });

  const root = mkdtempSync(join(tmpdir(), "deyin-engine-missing-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "home", "token"), TOKEN, { mode: 0o600 });
  const running = await startBotEngine({ version: "1.2.3", home: join(root, "home"), port: 0, deyin: { command: join(root, "no-such-deyin"), args: [] } });
  cleanups.push(() => running.close());
  const res = await fetch(`http://127.0.0.1:${running.port}${ENGINE_PATHS.status}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.deepEqual(((await res.json()) as EngineStatus).agent, { found: false, signedIn: false });
});

/* Files ----------------------------------------------------------------------- */

test("files go in, come out, list and are removed, over the wire", async () => {
  const h = await harness();
  const put = await h.call("PUT", `${ENGINE_PATHS.fileContent("b1")}?path=notes%2Ftoday.md`, { content: "# Today\n" });
  assert.equal(put.status, 200);
  const got = await h.call("GET", `${ENGINE_PATHS.fileContent("b1")}?path=notes/today.md`);
  assert.deepEqual(got.body, { content: "# Today\n" });
  const list = await h.call("GET", `${ENGINE_PATHS.fileList("b1")}?path=`);
  assert.deepEqual((list.body.entries as Array<{ name: string; kind: string }>).map((e) => [e.name, e.kind]), [["notes", "directory"]]);
  assert.equal((await h.call("DELETE", `${ENGINE_PATHS.files("b1")}?path=notes`)).status, 409, "a folder with things in it needs asking twice");
  assert.equal((await h.call("DELETE", `${ENGINE_PATHS.files("b1")}?path=notes&recursive=1`)).status, 200);
  assert.equal((await h.call("GET", `${ENGINE_PATHS.fileContent("b1")}?path=notes/today.md`)).status, 404);
  assert.equal(readFileSync(join(h.home, "token"), "utf8"), TOKEN, "the key was never touched");
});

test("a path cannot leave the Bot's folder, by dots, by a link, or by a Bot id", async () => {
  const h = await harness();
  await h.call("PUT", `${ENGINE_PATHS.fileContent("b1")}?path=ok.txt`, { content: "x" });
  const content = (path: string) => `${ENGINE_PATHS.fileContent("b1")}?path=${encodeURIComponent(path)}`;
  for (const bad of ["../../token", "../../../../etc/passwd", "/etc/passwd", "a/../../b", "..\\..\\token"]) {
    assert.equal((await h.call("GET", content(bad))).status, 400, `read ${bad}`);
    assert.equal((await h.call("PUT", content(bad), { content: "pwned" })).status, 400, `write ${bad}`);
    assert.equal((await h.call("DELETE", `${ENGINE_PATHS.files("b1")}?path=${encodeURIComponent(bad)}`)).status, 400, `remove ${bad}`);
  }
  // A link in the Bot's folder to the engine's own key.
  symlinkSync(join(h.home, "token"), join(h.filesDir("b1"), "key-link"));
  symlinkSync(h.home, join(h.filesDir("b1"), "home-link"));
  assert.equal((await h.call("GET", content("key-link"))).status, 400);
  assert.equal((await h.call("GET", content("home-link/token"))).status, 400);
  assert.equal((await h.call("PUT", content("home-link/planted.txt"), { content: "x" })).status, 400);
  assert.equal(existsSync(join(h.home, "planted.txt")), false);
  assert.equal((await h.call("DELETE", `${ENGINE_PATHS.files("b1")}?path=key-link`)).status, 200, "a link can be removed");
  assert.equal(readFileSync(join(h.home, "token"), "utf8"), TOKEN, "and removing it left the key");
  // A Bot id is one name, not a route.
  for (const id of ["a%2Fb", "a b", "x".repeat(65), "%00"]) {
    assert.equal((await h.call("GET", `/v1/bots/${id}/files/list`)).status, 400, `Bot id ${id}`);
  }
  // Dots are collapsed by the URL before the engine sees them, so these reach no Bot route at all.
  for (const id of ["..", "%2E%2E"]) {
    assert.ok([400, 404].includes((await h.call("GET", `/v1/bots/${id}/files/list`)).status), `Bot id ${id}`);
  }
  assert.equal((await h.call("GET", "/v1/bots/%E0%A4%A/files/list")).status, 400, "an id that is not valid text");
  assert.equal(readdirSync(join(h.home, "bots")).join(","), "b1", "no other folder was made");
});

test("a file's content must be text, and not too large", async () => {
  const h = await harness();
  assert.equal((await h.call("PUT", `${ENGINE_PATHS.fileContent("b1")}?path=a.txt`, { content: 5 })).status, 400);
  assert.equal((await h.call("PUT", `${ENGINE_PATHS.fileContent("b1")}?path=a.txt`, {})).status, 400);
  assert.equal((await h.call("PUT", `${ENGINE_PATHS.fileContent("b1")}?path=a.txt`, { content: "x".repeat(RUNTIME_LIMITS.fileBytes + 1) })).status, 429);
  const res = await fetch(`${h.base}${ENGINE_PATHS.fileContent("b1")}?path=a.txt`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` }, body: "{not json" });
  assert.equal(res.status, 400);
});

/* Commands -------------------------------------------------------------------- */

test("a command streams its output and says how it ended", async () => {
  const h = await harness();
  await h.call("PUT", `${ENGINE_PATHS.fileContent("b1")}?path=hello.txt`, { content: "hi there" });
  const { status, lines } = await h.lines("POST", ENGINE_PATHS.exec("b1"), { command: "cat hello.txt; echo oops 1>&2; exit 3" });
  assert.equal(status, 200);
  const parsed = lines.map((l) => parseExecLine(l));
  assert.ok(parsed.every((p): p is EngineExecLine => p !== null), "every line is a protocol line");
  assert.equal(parsed.at(-1)?.type, "exit");
  const collector = new ExecCollector(RUNTIME_LIMITS.outputBytes);
  for (const line of parsed as EngineExecLine[]) collector.add(line);
  assert.deepEqual(collector.finish(), { code: 3, timedOut: false, stdout: "hi there", stderr: "oops\n", truncated: false });
});

test("a command that is not allowed is refused before it runs", async () => {
  const h = await harness();
  for (const bad of [{ command: "" }, { command: "touch pwned", cwd: "../.." }, { command: "x".repeat(RUNTIME_LIMITS.commandLength + 1) }, { command: "echo", timeoutMs: 5 }]) {
    assert.equal((await h.lines("POST", ENGINE_PATHS.exec("b1"), bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(existsSync(join(h.home, "pwned")), false);
  assert.equal((await h.lines("POST", ENGINE_PATHS.exec("b1"), { command: "ls", cwd: "missing" })).status, 404);
});

test("hanging up stops a command, and what it started", async () => {
  const h = await harness();
  const controller = new AbortController();
  const pending = fetch(`${h.base}${ENGINE_PATHS.exec("b1")}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ command: "sleep 30 & echo $! > child.pid; wait" }),
    signal: controller.signal,
  }).catch(() => undefined);
  const pidFile = join(h.filesDir("b1"), "child.pid");
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the command to start");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.equal(alive(pid), true);
  controller.abort();
  await pending;
  await until(() => !alive(pid), "the command's child to be stopped");
});

/* Agent runs ------------------------------------------------------------------ */

test("an agent run streams what the agent prints, and the engine says how it ended", async () => {
  const h = await harness();
  const { status, lines } = await h.lines("POST", ENGINE_PATHS.run("b1"), { prompt: "ECHO hi", model: "xai::grok", mode: "read_only" });
  assert.equal(status, 200);
  assert.deepEqual(lines.slice(0, -1), ['{"type":"text-delta","delta":"thinking"}', '{"type":"result","finalText":"echo: ECHO hi","reason":"completed"}']);
  assert.deepEqual(parseRunEnd(lines.at(-1)!), { type: "engine-exit", code: 0, timedOut: false, aborted: false });
});

test("the agent runs in the Bot's folder, with the prompt on stdin and never on the command line", async () => {
  const h = await harness();
  const prompt = "WRITE a very private instruction";
  await h.lines("POST", ENGINE_PATHS.run("b1"), { prompt, model: "xai::grok", mode: "run_everything", maxSteps: 7 });
  const [run] = h.agentRuns();
  assert.ok(run);
  assert.equal(run.stdin, prompt);
  assert.equal(run.argv.some((a) => a.includes("private")), false, "the prompt is not in the arguments");
  assert.deepEqual(run.argv, ["run", "--json", "-C", h.filesDir("b1"), "-m", "xai::grok", "-y", "--max-steps", "7"]);
  assert.equal(readFileSync(join(h.filesDir("b1"), "made-by-agent.txt"), "utf8"), "hi", "it ran in the Bot's own folder");
});

test("read_only leaves out the flag that lets the agent do anything", async () => {
  const h = await harness();
  await h.lines("POST", ENGINE_PATHS.run("b1"), { prompt: "ECHO", model: "m", mode: "read_only" });
  assert.deepEqual(h.agentRuns()[0]?.argv, ["run", "--json", "-C", h.filesDir("b1"), "-m", "m"]);
  assert.equal(h.agentRuns()[0]?.argv.includes("-y"), false);
  assert.deepEqual(agentArguments({ model: "m", mode: "run_everything" }, "/x"), ["run", "--json", "-C", "/x", "-m", "m", "-y"]);
});

test("a line the agent prints that claims to be the end of the run is not passed on", async () => {
  const h = await harness();
  const { lines } = await h.lines("POST", ENGINE_PATHS.run("b1"), { prompt: "SPOOF", model: "m", mode: "read_only" });
  const ends = lines.filter((l) => parseRunEnd(l) !== null);
  assert.equal(ends.length, 1, "only the engine's own end line");
  assert.equal(lines.at(-1), ends[0]);
  assert.equal(parseRunEnd(ends[0]!)?.code, 0);
  assert.ok(lines.some((l) => l.includes('"type":"result"')), "the rest of what the agent printed did come through");
});

test("lines that are not JSON, or arrive in two pieces, still come through whole", async () => {
  const h = await harness();
  const { lines } = await h.lines("POST", ENGINE_PATHS.run("b1"), { prompt: "NOISE", model: "m", mode: "read_only" });
  assert.ok(lines.includes("not json at all"));
  assert.ok(lines.includes('{"type":"text-delta","delta":"split across two writes"}'));
});

test("an agent that fails is reported with its exit code, not hidden", async () => {
  const h = await harness();
  const failed = await h.lines("POST", ENGINE_PATHS.run("b1"), { prompt: "FAIL", model: "m", mode: "read_only" });
  assert.equal(parseRunEnd(failed.lines.at(-1)!)?.code, 1);
  assert.equal(parseRunEnd(failed.lines.at(-1)!)?.stderr, "boom happened", "and why, from what the agent wrote");
  const fine = await h.lines("POST", ENGINE_PATHS.run("b1"), { prompt: "ECHO", model: "m", mode: "read_only" });
  assert.equal(parseRunEnd(fine.lines.at(-1)!)?.stderr, undefined, "a run that completed has nothing to explain");
  const auth = await h.lines("POST", ENGINE_PATHS.run("b1"), { prompt: "AUTH", model: "m", mode: "read_only" });
  assert.equal(parseRunEnd(auth.lines.at(-1)!)?.code, 2);
});

test("an agent that cannot be started says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "deyin-engine-nodeyin-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "home", "token"), TOKEN, { mode: 0o600 });
  const running = await startBotEngine({ version: "1.2.3", home: join(root, "home"), port: 0, deyin: { command: join(root, "no-such-deyin"), args: [] } });
  cleanups.push(() => running.close());
  const res = await fetch(`http://127.0.0.1:${running.port}${ENGINE_PATHS.run("b1")}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ prompt: "ECHO", model: "m", mode: "read_only" }),
  });
  const end = parseRunEnd((await res.text()).trim().split("\n").at(-1)!);
  assert.equal(end?.code, null);
  assert.match(end?.error ?? "", /Could not start deyin/);
});

test("a run that goes past its time limit is stopped and says so", async () => {
  const h = await harness();
  const started = Date.now();
  const { lines } = await h.lines("POST", ENGINE_PATHS.run("b1"), { prompt: "SLEEP", model: "m", mode: "read_only", timeoutMs: 1_000 });
  const end = parseRunEnd(lines.at(-1)!);
  assert.equal(end?.timedOut, true);
  assert.equal(end?.code, null);
  assert.ok(Date.now() - started < 10_000);
  const pid = Number(readFileSync(join(h.logDir, "sleeping.pid"), "utf8"));
  await until(() => !alive(pid), "the agent to be gone");
});

test("hanging up on a run stops the agent", async () => {
  const h = await harness();
  const controller = new AbortController();
  const pending = fetch(`${h.base}${ENGINE_PATHS.run("b1")}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ prompt: "SLEEP", model: "m", mode: "read_only" }),
    signal: controller.signal,
  }).catch(() => undefined);
  const pidFile = join(h.logDir, "sleeping.pid");
  await until(() => existsSync(pidFile), "the agent to start");
  const pid = Number(readFileSync(pidFile, "utf8"));
  controller.abort();
  await pending;
  await until(() => !alive(pid), "the agent to be stopped");
  await until(async () => ((await h.call("GET", ENGINE_PATHS.status)).body as EngineStatus).runningNow === 0, "the place to be given back");
});

test("a server that is already busy turns a new run away and takes it once there is room", async () => {
  const h = await harness({ engine: { maxConcurrentRuns: 1 } });
  const controller = new AbortController();
  const first = fetch(`${h.base}${ENGINE_PATHS.run("b1")}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ prompt: "SLEEP", model: "m", mode: "read_only" }),
    signal: controller.signal,
  }).catch(() => undefined);
  await until(() => existsSync(join(h.logDir, "sleeping.pid")), "the first run to start");
  const refused = await h.lines("POST", ENGINE_PATHS.run("b2"), { prompt: "ECHO", model: "m", mode: "read_only" });
  assert.equal(refused.status, 429);
  assert.match(JSON.parse(refused.lines[0]!).error, /already running 1 thing for your Bots/);
  assert.equal(h.agentRuns().length, 1, "the refused run never started an agent");
  controller.abort();
  await first;
  await until(async () => ((await h.call("GET", ENGINE_PATHS.status)).body as EngineStatus).runningNow === 0, "room");
  assert.equal((await h.lines("POST", ENGINE_PATHS.run("b2"), { prompt: "ECHO", model: "m", mode: "read_only" })).status, 200);
});

test("a run request that is not allowed never starts an agent", async () => {
  const h = await harness();
  for (const bad of [{}, { prompt: "x", model: "m" }, { prompt: "x", model: "m", mode: "auto_review" }, { prompt: "", model: "m", mode: "read_only" }, { prompt: "x", model: "a b", mode: "read_only" }]) {
    assert.equal((await h.lines("POST", ENGINE_PATHS.run("b1"), bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(h.agentRuns().length, 0);
});

/* Routines -------------------------------------------------------------------- */

test("a routine is kept, scheduled and listed", async () => {
  const h = await harness();
  const saved = await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody());
  assert.equal(saved.status, 200);
  const routine = saved.body.routine as EngineRoutineView;
  assert.equal(routine.id, "r1");
  assert.ok(routine.nextRunAt && routine.nextRunAt > Date.now(), "it has a next run");
  const list = (await h.call("GET", ENGINE_PATHS.routines("b1"))).body.routines as EngineRoutineView[];
  assert.deepEqual(list.map((r) => r.id), ["r1"]);
  const paused = await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ enabled: false }));
  assert.equal((paused.body.routine as EngineRoutineView).nextRunAt, undefined, "a paused routine has no next run");
});

test("a schedule that does not parse, never runs, or is too frequent is refused and not kept", async () => {
  const h = await harness();
  for (const [cron, message] of [
    ["not a cron", /does not parse/],
    ["* * * * *", /once every 5 minutes/],
    ["*/4 * * * *", /once every 5 minutes/],
    ["0 0 30 2 *", /never runs/],
  ] as const) {
    const res = await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ cron }));
    assert.equal(res.status, 400, cron);
    assert.match(res.body.error, message, cron);
  }
  assert.equal((await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ cron: "*/5 * * * *" }))).status, 200, "every five minutes is the limit, and allowed");
  assert.equal((await h.call("GET", ENGINE_PATHS.routines("b1"))).body.routines.length, 1, "only the good one is kept");
});

test("a routine's id and body are checked", async () => {
  const h = await harness();
  assert.equal((await h.call("PUT", "/v1/bots/b1/routines/..%2Fx", routineBody())).status, 400);
  assert.equal((await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ mode: "auto_review" }))).status, 400);
  assert.equal((await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ prompt: "" }))).status, 400);
  assert.equal((await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), "nope")).status, 400);
  assert.equal((await h.call("DELETE", "/v1/bots/b1/routines/..%2Fx")).status, 400);
  assert.equal((await h.call("POST", "/v1/bots/b1/routines/missing/run")).status, 404);
});

test("a Bot keeps at most fifty routines, and a server at most two hundred Bots", async () => {
  const h = await harness();
  for (let i = 0; i < RUNTIME_LIMITS.routinesPerBot; i++) {
    assert.equal((await h.call("PUT", ENGINE_PATHS.routine("b1", `r${i}`), routineBody())).status, 200, `routine ${i}`);
  }
  const over = await h.call("PUT", ENGINE_PATHS.routine("b1", "one-more"), routineBody());
  assert.equal(over.status, 429);
  assert.match(over.body.error, /at most 50 routines/);
  assert.equal((await h.call("PUT", ENGINE_PATHS.routine("b1", "r0"), routineBody({ name: "Renamed" }))).status, 200, "changing one that exists is not adding");

  const store = new EngineStore(h.home);
  for (let i = 0; i < RUNTIME_LIMITS.bots - 2; i++) store.ensureBot(`filler${i}`); // with b1, 199 Bots
  assert.equal((await h.call("PUT", `${ENGINE_PATHS.fileContent("last")}?path=a.txt`, { content: "x" })).status, 200, "the last place");
  const full = await h.call("PUT", `${ENGINE_PATHS.fileContent("too-many")}?path=a.txt`, { content: "x" });
  assert.equal(full.status, 429);
  assert.match(full.body.error, /at most 200 Bots/);
  assert.equal(existsSync(join(h.home, "bots", "too-many")), false);
});

test("a routine run by hand starts at once and is recorded when it ends", async () => {
  const h = await harness();
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ prompt: "ECHO hello", mode: "run_everything" }));
  const started = await h.call("POST", ENGINE_PATHS.routineRun("b1", "r1"));
  assert.equal(started.status, 202);
  const run = started.body.run as EngineRunRecord;
  assert.equal(run.status, "running");
  assert.equal(run.trigger, "manual");
  await h.running.engine.idle();
  const runs = (await h.call("GET", ENGINE_PATHS.routineRuns("b1", "r1"))).body.runs as EngineRunRecord[];
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.id, run.id);
  assert.equal(runs[0]?.status, "completed");
  assert.equal(runs[0]?.finalText, "echo: ECHO hello");
  assert.ok(runs[0]?.finishedAt && runs[0].finishedAt >= runs[0].startedAt);
  assert.ok(h.agentRuns()[0]?.argv.includes("-y"), "it ran with the mode the routine has");
  const view = (await h.call("GET", ENGINE_PATHS.routines("b1"))).body.routines[0] as EngineRoutineView;
  assert.equal(view.lastRun?.status, "completed");
});

test("a routine that fails, hits its step limit or is not signed in says which", async () => {
  const h = await harness();
  const record = async (id: string, prompt: string): Promise<EngineRunRecord> => {
    await h.call("PUT", ENGINE_PATHS.routine("b1", id), routineBody({ prompt }));
    await h.call("POST", ENGINE_PATHS.routineRun("b1", id));
    await h.running.engine.idle();
    return (await h.call("GET", ENGINE_PATHS.routineRuns("b1", id))).body.runs[0] as EngineRunRecord;
  };
  const failed = await record("f", "FAIL");
  assert.equal(failed.status, "failed");
  assert.match(failed.reason ?? "", /exit code 1.*boom happened/);
  const auth = await record("a", "AUTH");
  assert.equal(auth.status, "failed");
  assert.match(auth.reason ?? "", /not signed in.*Servers page/);
  const steps = await record("s", "STEPS");
  assert.equal(steps.status, "completed");
  assert.match(steps.reason ?? "", /step limit/);
  assert.equal(steps.finalText, "partial");
});

test("a routine past its time limit is recorded as a timeout", async () => {
  const h = await harness();
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ prompt: "SLEEP", timeoutMs: 1_000 }));
  await h.call("POST", ENGINE_PATHS.routineRun("b1", "r1"));
  await h.running.engine.idle();
  const run = (await h.call("GET", ENGINE_PATHS.routineRuns("b1", "r1"))).body.runs[0] as EngineRunRecord;
  assert.equal(run.status, "timeout");
  assert.match(run.reason ?? "", /time limit/);
});

test("a schedule firing runs the routine as it is now, and not when it has been paused", async () => {
  const jobs = fakeJobs();
  const h = await harness({ engine: { jobFactory: jobs.factory } });
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ prompt: "ECHO scheduled" }));
  assert.equal(jobs.live().length, 1);
  assert.equal(jobs.live()[0]?.expression, "0 8 * * *");
  jobs.live()[0]!.tick();
  await h.running.engine.idle();
  let runs = (await h.call("GET", ENGINE_PATHS.routineRuns("b1", "r1"))).body.runs as EngineRunRecord[];
  assert.deepEqual(runs.map((r) => [r.trigger, r.status, r.finalText]), [["schedule", "completed", "echo: ECHO scheduled"]]);

  // An edit applies to the next firing, from the file, even though the job was made before it.
  const store = new EngineStore(h.home);
  const [routine] = store.routines("b1");
  store.saveRoutine("b1", { ...routine!, prompt: "ECHO edited" });
  jobs.live()[0]!.tick();
  await h.running.engine.idle();
  runs = (await h.call("GET", ENGINE_PATHS.routineRuns("b1", "r1"))).body.runs as EngineRunRecord[];
  assert.equal(runs[0]?.finalText, "echo: ECHO edited");

  // Paused on disk but the job still fires (a race): no run.
  const before = runs.length;
  store.saveRoutine("b1", { ...routine!, enabled: false });
  jobs.live()[0]!.tick();
  await h.running.engine.idle();
  assert.equal(((await h.call("GET", ENGINE_PATHS.routineRuns("b1", "r1"))).body.runs as EngineRunRecord[]).length, before);
});

test("pausing, changing or deleting a routine stops its old schedule", async () => {
  const jobs = fakeJobs();
  const h = await harness({ engine: { jobFactory: jobs.factory } });
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody());
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r2"), routineBody());
  assert.equal(jobs.live().length, 2);
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ cron: "0 9 * * *" }));
  assert.deepEqual(jobs.live().map((j) => j.expression).sort(), ["0 8 * * *", "0 9 * * *"], "r1 changed, r2 is as it was");
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ enabled: false }));
  assert.equal(jobs.live().length, 1);
  assert.equal((await h.call("DELETE", ENGINE_PATHS.routine("b1", "r2"))).body.removed, true);
  assert.equal(jobs.live().length, 0, "nothing is left scheduled");
  assert.equal((await h.call("DELETE", ENGINE_PATHS.routine("b1", "r2"))).body.removed, false);
});

test("a routine already running is not started again by its schedule, and a busy server skips it with a reason", async () => {
  const jobs = fakeJobs();
  const h = await harness({ engine: { jobFactory: jobs.factory, maxConcurrentRuns: 1 } });
  await h.call("PUT", ENGINE_PATHS.routine("b1", "slow"), routineBody({ prompt: "SLEEP" }));
  await h.call("PUT", ENGINE_PATHS.routine("b1", "other"), routineBody({ prompt: "ECHO other" }));
  const [slowJob, otherJob] = jobs.live();
  slowJob!.tick();
  await until(() => existsSync(join(h.logDir, "sleeping.pid")), "the slow routine to start");

  slowJob!.tick();
  otherJob!.tick();
  const slowRuns = (await h.call("GET", ENGINE_PATHS.routineRuns("b1", "slow"))).body.runs as EngineRunRecord[];
  assert.deepEqual(slowRuns.map((r) => r.status).sort(), ["running", "skipped"]);
  assert.match(slowRuns.find((r) => r.status === "skipped")?.reason ?? "", /previous run was still going/);
  const otherRuns = (await h.call("GET", ENGINE_PATHS.routineRuns("b1", "other"))).body.runs as EngineRunRecord[];
  assert.equal(otherRuns[0]?.status, "skipped");
  assert.match(otherRuns[0]?.reason ?? "", /already running 1 thing\./);

  assert.equal((await h.call("POST", ENGINE_PATHS.routineRun("b1", "slow"))).status, 409, "by hand: already running");
  assert.equal((await h.call("POST", ENGINE_PATHS.routineRun("b1", "other"))).status, 429, "by hand: the server is busy");
});

test("only the last twenty runs of a routine are kept", async () => {
  const h = await harness();
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody());
  const store = new EngineStore(h.home);
  for (let i = 0; i < RUNTIME_LIMITS.runRecords + 5; i++) {
    store.recordRun("b1", { id: `run_${i}`, routineId: "r1", startedAt: 1_000 + i, status: "completed", trigger: "schedule" });
  }
  const runs = (await h.call("GET", ENGINE_PATHS.routineRuns("b1", "r1"))).body.runs as EngineRunRecord[];
  assert.equal(runs.length, RUNTIME_LIMITS.runRecords);
  assert.equal(runs[0]?.id, `run_${RUNTIME_LIMITS.runRecords + 4}`, "newest first");
  assert.equal(runs.at(-1)?.id, "run_5", "the oldest five were dropped");
});

test("after a restart, routines are still there and scheduled, and a run the crash cut short is marked", async () => {
  const jobs1 = fakeJobs();
  const h = await harness({ engine: { jobFactory: jobs1.factory } });
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody());
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r2"), routineBody({ enabled: false }));
  new EngineStore(h.home).recordRun("b1", { id: "run_cut", routineId: "r1", startedAt: 1, status: "running", trigger: "schedule" });
  await h.running.close();

  const jobs2 = fakeJobs();
  const again = await startBotEngine({ version: "1.2.3", home: h.home, port: 0, deyin: { command: process.execPath, args: [FAKE_DEYIN] }, engine: { jobFactory: jobs2.factory } });
  cleanups.push(() => again.close());
  assert.equal(jobs2.live().length, 1, "only the routine that is on is scheduled");
  assert.equal(jobs2.live()[0]?.expression, "0 8 * * *");
  const run = new EngineStore(h.home).runs("b1", "r1").find((r) => r.id === "run_cut");
  assert.equal(run?.status, "failed");
  assert.match(run?.reason ?? "", /stopped before this run finished/);
  assert.ok(run?.finishedAt);
});

test("stopping the engine stops a run in flight and records it", async () => {
  const h = await harness();
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ prompt: "SLEEP" }));
  await h.call("POST", ENGINE_PATHS.routineRun("b1", "r1"));
  await until(() => existsSync(join(h.logDir, "sleeping.pid")), "the run to start");
  const pid = Number(readFileSync(join(h.logDir, "sleeping.pid"), "utf8"));
  await h.running.close();
  assert.equal(alive(pid), false, "the agent did not outlive the engine");
  const run = new EngineStore(h.home).runs("b1", "r1")[0];
  assert.equal(run?.status, "aborted");
});

test("removing a Bot removes its files, routines and schedules", async () => {
  const jobs = fakeJobs();
  const h = await harness({ engine: { jobFactory: jobs.factory } });
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody());
  await h.call("PUT", `${ENGINE_PATHS.fileContent("b1")}?path=a.txt`, { content: "x" });
  await h.call("PUT", `${ENGINE_PATHS.fileContent("b2")}?path=a.txt`, { content: "x" });
  assert.equal(jobs.live().length, 1);
  assert.equal((await h.call("DELETE", ENGINE_PATHS.bot("b1"))).body.removed, true);
  assert.equal(existsSync(join(h.home, "bots", "b1")), false);
  assert.equal(jobs.live().length, 0);
  assert.equal(existsSync(join(h.home, "bots", "b2", "files", "a.txt")), true, "another Bot is untouched");
  assert.equal((await h.call("DELETE", ENGINE_PATHS.bot("b1"))).body.removed, false);
  assert.equal((await h.call("GET", ENGINE_PATHS.routines("b1"))).body.routines.length, 0);
});

test("a routines file that will not parse is set aside, not lost and not run", async () => {
  const h = await harness();
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody());
  writeFileSync(join(h.home, "bots", "b1", "routines.json"), "{ this is not json");
  assert.deepEqual((await h.call("GET", ENGINE_PATHS.routines("b1"))).body.routines, []);
  assert.ok(readdirSync(join(h.home, "bots", "b1")).some((n) => n.startsWith("routines.json.corrupt-")), "the broken file was kept for a person to look at");
});

test("a routine on disk that no longer passes the checks is dropped, not run", async () => {
  const jobs = fakeJobs();
  const h = await harness({ engine: { jobFactory: jobs.factory } });
  await h.call("PUT", ENGINE_PATHS.routine("b1", "good"), routineBody());
  const file = join(h.home, "bots", "b1", "routines.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  parsed.routines.push({ id: "evil", name: "x", cron: "* * * * *", prompt: "p", model: "m", mode: "root", enabled: true });
  parsed.routines.push({ id: "../escape", name: "x", cron: "0 8 * * *", prompt: "p", model: "m", mode: "read_only", enabled: true });
  writeFileSync(file, JSON.stringify(parsed));
  assert.deepEqual(new EngineStore(h.home).routines("b1").map((r) => r.id), ["good"]);
});

test("a too-frequent schedule edited into the file is reported and left unscheduled", async () => {
  const jobs = fakeJobs();
  const h = await harness({ engine: { jobFactory: jobs.factory } });
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody());
  const store = new EngineStore(h.home);
  store.saveRoutine("b1", { ...store.routines("b1")[0]!, cron: "* * * * *" });
  const problems = h.running.engine["scheduler"].syncBot("b1");
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.error, /once every 5 minutes/);
  assert.equal(jobs.live().length, 0);
});

test("a routine deleted while it runs leaves no record of that run behind", async () => {
  const h = await harness();
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody({ prompt: "SLEEP" }));
  await h.call("POST", ENGINE_PATHS.routineRun("b1", "r1"));
  await until(() => existsSync(join(h.logDir, "sleeping.pid")), "the run to start");
  assert.equal(new EngineStore(h.home).runs("b1", "r1").length, 1);
  assert.equal((await h.call("DELETE", ENGINE_PATHS.routine("b1", "r1"))).body.removed, true);
  assert.equal(existsSync(join(h.home, "bots", "b1", "runs", "r1.json")), false, "its history went with it");
  await h.running.close();
  assert.equal(existsSync(join(h.home, "bots", "b1", "runs", "r1.json")), false, "and the run that ended afterwards did not bring it back");
});

test("what the engine keeps is private to the user it runs as", async () => {
  if (process.platform === "win32") return;
  const h = await harness();
  await h.call("PUT", ENGINE_PATHS.routine("b1", "r1"), routineBody());
  await h.call("POST", ENGINE_PATHS.routineRun("b1", "r1"));
  await h.running.engine.idle();
  await h.call("PUT", `${ENGINE_PATHS.fileContent("b1")}?path=n/a.txt`, { content: "x" });
  const mode = (path: string): number => statSync(path).mode & 0o777;
  assert.equal(mode(join(h.home, "bots", "b1", "routines.json")), 0o600, "routines hold instructions");
  assert.equal(mode(join(h.home, "bots", "b1", "runs", "r1.json")), 0o600, "runs hold what the Bot said");
  assert.equal(mode(h.home), 0o700);
  assert.equal(mode(join(h.home, "bots")), 0o700);
  assert.equal(mode(h.filesDir("b1")), 0o700);
  assert.equal(mode(join(h.filesDir("b1"), "n", "a.txt")), 0o600, "a file the Bot is given is not world-readable");
});

/* The agent command ----------------------------------------------------------- */

test("the engine finds the agent it should run", () => {
  assert.deepEqual(resolveDeyinCommand({ override: "/usr/local/bin/deyin" }), { command: "/usr/local/bin/deyin", args: [] });
  assert.deepEqual(resolveDeyinCommand({ env: { DEYIN_BIN: "/opt/deyin" } }), { command: "/opt/deyin", args: [] });
  assert.deepEqual(resolveDeyinCommand({ override: "/a", env: { DEYIN_BIN: "/b" } }), { command: "/a", args: [] }, "the flag wins");
  assert.deepEqual(resolveDeyinCommand({ execPath: "/home/u/.local/bin/deyin", script: "/$bunfs/root/deyin" }), { command: "/home/u/.local/bin/deyin", args: [] }, "a compiled binary is its own command");
  assert.deepEqual(resolveDeyinCommand({ execPath: "/home/u/deyin-linux-x64" }), { command: "/home/u/deyin-linux-x64", args: [] });
  assert.deepEqual(resolveDeyinCommand({ execPath: "/usr/bin/node", script: "/app/dist/index.js", env: {} }), { command: "/usr/bin/node", args: ["/app/dist/index.js"] }, "under Node, Node runs the script");
  assert.deepEqual(resolveDeyinCommand({ override: "   ", execPath: "/usr/bin/node", script: "/s.js", env: {} }), { command: "/usr/bin/node", args: ["/s.js"] }, "a blank override is no override");
});
