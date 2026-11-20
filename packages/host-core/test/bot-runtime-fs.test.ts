import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ExecCollector, type EngineExecLine } from "../src/bots/engine-protocol.js";
import { RUNTIME_LIMITS } from "../src/bots/runtime.js";
import {
  listBotFiles,
  readBotFile,
  removeBotFile,
  resolveInsideRoot,
  streamBotCommand,
  writeBotFile,
} from "../src/bots/runtime-fs.js";
import { BotError } from "../src/bots/types.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A Bot folder, and a folder beside it that a Bot must never reach. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "deyin-runtime-fs-"));
  dirs.push(dir);
  const root = join(dir, "bot", "files");
  const outside = join(dir, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "top secret");
  return { dir, root, outside };
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

async function run(root: string, command: string, extra: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}) {
  const lines: EngineExecLine[] = [];
  await streamBotCommand(root, { command, ...extra }, (line) => lines.push(line), extra.signal ? { signal: extra.signal } : {});
  const collector = new ExecCollector(RUNTIME_LIMITS.outputBytes);
  for (const line of lines) collector.add(line);
  const result = collector.finish();
  assert.ok(result, "the command said how it ended");
  assert.equal(lines.at(-1)?.type, "exit", "the exit line is last");
  return result;
}

test("the Bot's folder is made on first use and starts empty", async () => {
  const { root } = setup();
  assert.deepEqual(await listBotFiles(root, ""), []);
  assert.equal(existsSync(root), true);
});

test("a file is written whole, read back, and listed with folders first", async () => {
  const { root } = setup();
  await writeBotFile(root, "notes/today.md", "# Today\nπ and é\n");
  await writeBotFile(root, "a.txt", "a");
  await writeBotFile(root, "b.txt", "bb");
  assert.equal(await readBotFile(root, "notes/today.md"), "# Today\nπ and é\n");
  const top = await listBotFiles(root, "");
  assert.deepEqual(
    top.map((e) => [e.name, e.kind, e.path]),
    [
      ["notes", "directory", "notes"],
      ["a.txt", "file", "a.txt"],
      ["b.txt", "file", "b.txt"],
    ],
  );
  assert.equal(top[2]?.size, 2);
  assert.equal((await listBotFiles(root, "notes"))[0]?.path, "notes/today.md");
  await writeBotFile(root, "a.txt", "replaced");
  assert.equal(await readBotFile(root, "a.txt"), "replaced");
  assert.deepEqual(
    readdirSync(root).filter((n) => n.endsWith(".tmp")),
    [],
    "no half-written file is left behind",
  );
});

test("reading, listing and removing what is not there say so", async () => {
  const { root } = setup();
  await refused(readBotFile(root, "nope.txt"), "not_found");
  await refused(listBotFiles(root, "nope"), "not_found");
  await refused(removeBotFile(root, "nope"), "not_found");
  await writeBotFile(root, "f.txt", "x");
  await refused(listBotFiles(root, "f.txt"), "invalid");
  await refused(readBotFile(root, ""), "invalid");
  mkdirSync(join(root, "dir"));
  await refused(readBotFile(root, "dir"), "invalid");
  await refused(writeBotFile(root, "dir", "x"), "conflict");
});

test("a file that is too large, or not text, is not read or written", async () => {
  const { root } = setup();
  await refused(writeBotFile(root, "big.txt", "x".repeat(RUNTIME_LIMITS.fileBytes + 1)), "limit");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "huge.txt"), Buffer.alloc(RUNTIME_LIMITS.fileBytes + 1, 97));
  await refused(readBotFile(root, "huge.txt"), "limit");
  writeFileSync(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  await refused(readBotFile(root, "bin.dat"), "invalid");
  await refused(writeBotFile(root, "x.txt", 5 as unknown as string), "invalid");
  await writeBotFile(root, "ok.txt", "x".repeat(RUNTIME_LIMITS.fileBytes));
  assert.equal((await readBotFile(root, "ok.txt")).length, RUNTIME_LIMITS.fileBytes, "exactly the limit is allowed");
});

test("a link inside the folder cannot lead a file operation outside it", async () => {
  const { root, outside } = setup();
  mkdirSync(root, { recursive: true });
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(outside, "secret.txt"), join(root, "peek.txt"));
  symlinkSync(join(outside, "missing.txt"), join(root, "dangling.txt"));

  await refused(readBotFile(root, "escape/secret.txt"), "invalid");
  await refused(readBotFile(root, "peek.txt"), "invalid");
  await refused(listBotFiles(root, "escape"), "invalid");
  await refused(writeBotFile(root, "escape/new.txt", "pwned"), "invalid");
  await refused(writeBotFile(root, "peek.txt", "pwned"), "invalid");
  await refused(writeBotFile(root, "dangling.txt", "pwned"), "invalid");
  await refused(writeBotFile(root, "escape/deeper/new.txt", "pwned"), "invalid");
  await refused(resolveInsideRoot(root, "escape/secret.txt"), "invalid");

  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "top secret", "the file outside is untouched");
  assert.equal(existsSync(join(outside, "new.txt")), false);
  assert.equal(existsSync(join(outside, "missing.txt")), false);
  assert.equal(existsSync(join(outside, "deeper")), false, "nothing was made outside either");

  const names = (await listBotFiles(root, "")).map((e) => e.name);
  assert.deepEqual(names, [], "links that lead out are not shown at all");
});

test("a link that stays inside the folder works like the file it points at", async () => {
  const { root } = setup();
  await writeBotFile(root, "real/a.txt", "inside");
  symlinkSync(join(root, "real"), join(root, "alias"));
  assert.equal(await readBotFile(root, "alias/a.txt"), "inside");
  assert.deepEqual((await listBotFiles(root, "")).map((e) => e.name).sort(), ["alias", "real"]);
});

test("removing a link removes the link and never what it points at", async () => {
  const { root, outside } = setup();
  mkdirSync(root, { recursive: true });
  symlinkSync(outside, join(root, "escape"));
  await removeBotFile(root, "escape");
  assert.equal(existsSync(join(root, "escape")), false, "the link is gone");
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "top secret", "and what it pointed at is not");
});

test("a folder with things in it is removed only when asked to, and the folder itself never is", async () => {
  const { root } = setup();
  await writeBotFile(root, "d/x.txt", "x");
  await refused(removeBotFile(root, "d"), "conflict");
  assert.equal(existsSync(join(root, "d", "x.txt")), true);
  await removeBotFile(root, "d", { recursive: true });
  assert.equal(existsSync(join(root, "d")), false);
  await writeBotFile(root, "e/x.txt", "x");
  await removeBotFile(root, "e/x.txt");
  await removeBotFile(root, "e");
  assert.equal(existsSync(join(root, "e")), false, "an empty folder goes without asking");
  await refused(removeBotFile(root, ""), "invalid");
  await refused(removeBotFile(root, "../outside"), "invalid");
  assert.equal(existsSync(root), true);
});

test("path refusals apply at this layer too, not only in the caller", async () => {
  const { root, outside } = setup();
  for (const bad of ["../outside/secret.txt", "/etc/passwd", "a/../../outside/secret.txt", "a\\b"]) {
    await refused(readBotFile(root, bad), "invalid");
    await refused(writeBotFile(root, bad, "x"), "invalid");
  }
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "top secret");
});

test("a command runs in the Bot's folder and its output and exit code come back", async () => {
  const { root } = setup();
  await writeBotFile(root, "hello.txt", "hi there");
  const result = await run(root, "cat hello.txt; echo oops 1>&2; exit 3");
  assert.deepEqual(
    { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, truncated: result.truncated },
    { code: 3, stdout: "hi there", stderr: "oops\n", timedOut: false, truncated: false },
  );
  assert.equal((await run(root, "pwd")).stdout.trim(), await resolveInsideRoot(root, ""));
});

test("a command can be run in a folder inside the Bot's, and not in one outside it", async () => {
  const { root, outside } = setup();
  await writeBotFile(root, "sub/f.txt", "x");
  assert.equal((await run(root, "ls", { cwd: "sub" })).stdout.trim(), "f.txt");
  await refused(streamBotCommand(root, { command: "ls", cwd: "../outside" }, () => undefined), "invalid");
  await refused(streamBotCommand(root, { command: "ls", cwd: "nope" }, () => undefined), "not_found");
  await refused(streamBotCommand(root, { command: "ls", cwd: "sub/f.txt" }, () => undefined), "invalid");
  symlinkSync(outside, join(root, "escape"));
  await refused(streamBotCommand(root, { command: "ls", cwd: "escape" }, () => undefined), "invalid");
});

test("a command that runs too long is stopped, with its children, and says so", async () => {
  const { root } = setup();
  const started = Date.now();
  const result = await run(root, "sleep 30 & echo $! > child.pid; wait", { timeoutMs: 1_000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.ok(Date.now() - started < 10_000, "it did not wait for the sleep");
  const pid = Number(readFileSync(join(root, "child.pid"), "utf8").trim());
  await new Promise((resolve) => setTimeout(resolve, 200));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the command's own child went down with it");
});

test("asking to stop kills the command; asking before it starts runs nothing", async () => {
  const { root } = setup();
  const controller = new AbortController();
  const pending = run(root, "sleep 30", { signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  const result = await pending;
  assert.equal(result.code, null);
  assert.equal(result.timedOut, false);

  const early = new AbortController();
  early.abort();
  const lines: EngineExecLine[] = [];
  await streamBotCommand(root, { command: "touch should-not-exist" }, (l) => lines.push(l), { signal: early.signal });
  assert.deepEqual(lines, [{ type: "exit", code: null, timedOut: false }]);
  assert.equal(existsSync(join(root, "should-not-exist")), false);
});

test("a command that cannot start says why instead of hanging", async () => {
  const { root } = setup();
  const result = await run(root, "definitely-not-a-command-xyz");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not found|not a command|No such file/i);
});

test("output past the limit is cut and the result says so", async () => {
  const { root } = setup();
  const result = await run(root, `head -c ${RUNTIME_LIMITS.outputBytes * 2} /dev/zero | tr '\\0' 'x'`);
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, RUNTIME_LIMITS.outputBytes);
  assert.equal(result.code, 0);
});
