import assert from "node:assert/strict";
import { test } from "node:test";
import { bashTool, parseWslPath } from "../src/tools/bash.js";
import { resolvePath } from "../src/tools/util.js";
import type { ToolContext } from "../src/types.js";

const ctx = (): ToolContext => ({ cwd: process.cwd(), todos: [] });

const isPosix = process.platform !== "win32";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("parseWslPath routes WSL2 project dirs to their distro (any platform)", () => {
  assert.deepEqual(parseWslPath("\\\\wsl$\\Ubuntu\\home\\anh\\proj"), {
    distro: "Ubuntu",
    linuxPath: "/home/user/proj",
  });
  // Win11 UNC form, hyphenated distro, and a trailing separator.
  assert.deepEqual(parseWslPath("\\\\wsl.localhost\\Ubuntu-22.04\\srv\\www\\"), {
    distro: "Ubuntu-22.04",
    linuxPath: "/srv/www",
  });
  // Distro root (no sub-path) resolves to "/".
  assert.deepEqual(parseWslPath("\\\\wsl$\\Debian"), { distro: "Debian", linuxPath: "/" });
  // Forward-slash variant is tolerated.
  assert.deepEqual(parseWslPath("//wsl$/Ubuntu/home/x"), { distro: "Ubuntu", linuxPath: "/home/x" });
  // Native Windows and POSIX paths are not WSL.
  assert.equal(parseWslPath("C:\\Users\\User\\proj"), null);
  assert.equal(parseWslPath("/home/user/proj"), null);
});

test("meta resolves the working directory the same way execute does", () => {
  const root = ctx();
  // No cwd arg: the workspace root.
  assert.equal(bashTool.meta?.({}, root)?.cwd, root.cwd);
  // Relative and absolute cwd args resolve against the workspace root.
  assert.equal(bashTool.meta?.({ cwd: "packages/ui" }, root)?.cwd, resolvePath(root.cwd, "packages/ui"));
  assert.equal(bashTool.meta?.({ cwd: "/tmp/build" }, root)?.cwd, resolvePath(root.cwd, "/tmp/build"));
});

test("runs a command and reports non-zero exit codes", { skip: !isPosix }, async () => {
  const ok = await bashTool.execute({ command: "echo hello" }, ctx());
  assert.ok(ok.includes("hello"));
  assert.ok(!ok.includes("exit code"));

  const fail = await bashTool.execute({ command: "echo boom >&2; exit 3" }, ctx());
  assert.ok(fail.includes("boom"));
  assert.ok(fail.includes("(exit code 3)"));
});

test("timeout kills the whole process group, not just the shell", { skip: !isPosix }, async () => {
  // The shell starts a background sleep (grandchild) and then blocks on `wait`.
  // Killing only the shell would orphan the sleep; the group kill must get it too.
  const result = await bashTool.execute(
    { command: "sleep 30 & echo CHILD:$!; wait", timeout_seconds: 1 },
    ctx(),
  );
  assert.ok(result.includes("timed out"), `expected timeout note, got: ${result}`);

  const match = result.match(/CHILD:(\d+)/);
  assert.ok(match, `expected the grandchild pid in output, got: ${result}`);
  const grandchild = Number(match![1]);

  // SIGKILL delivery to the group is immediate; allow a short grace for reaping.
  let alive = processAlive(grandchild);
  for (let i = 0; i < 20 && alive; i++) {
    await sleep(100);
    alive = processAlive(grandchild);
  }
  assert.equal(alive, false, `grandchild sleep (pid ${grandchild}) survived the group kill`);
});

test("abort cancels the command and kills its tree", { skip: !isPosix }, async () => {
  const controller = new AbortController();
  const pending = bashTool.execute(
    { command: "sleep 30 & echo CHILD:$!; wait" },
    { ...ctx(), signal: controller.signal },
  );
  await sleep(300);
  controller.abort();
  const result = await pending;
  assert.ok(result.includes("cancelled"), `expected cancellation note, got: ${result}`);

  const match = result.match(/CHILD:(\d+)/);
  assert.ok(match, `expected the grandchild pid in output, got: ${result}`);
  let alive = processAlive(Number(match![1]));
  for (let i = 0; i < 20 && alive; i++) {
    await sleep(100);
    alive = processAlive(Number(match![1]));
  }
  assert.equal(alive, false, "grandchild survived the abort kill");
});

test("block_until_ms=0 registers a background task and returns task_id", { skip: !isPosix }, async () => {
  const tasks = new Map<string, Promise<{ output: string; exitCode: number | null }>>();
  const toolCtx: ToolContext = {
    ...ctx(),
    registerBackgroundTask: (taskId, promise) => {
      tasks.set(taskId, promise);
    },
  };
  const result = await bashTool.execute({ command: "echo bg-ok", block_until_ms: 0 }, toolCtx);
  assert.match(result, /task_id: /);
  const taskId = result.match(/task_id: ([^\n]+)/)?.[1];
  assert.ok(taskId);
  const promise = tasks.get(taskId!);
  assert.ok(promise);
  // The child is spawned detached and unref'd (background tasks must not hold the
  // app open), so under parallel-suite load the event loop can drain before the
  // close event is delivered. Bound the wait instead of awaiting it bare.
  const output = await Promise.race([
    promise!.then((o) => o),
    sleep(10_000).then(() => {
      throw new Error("background task did not resolve within 10s");
    }),
  ]);
  assert.ok(output.output.includes("bg-ok"));
});
