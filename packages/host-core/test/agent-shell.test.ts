import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentShell, agentShellAvailable } from "../src/host/agent-shell.js";

const isPosix = process.platform !== "win32";

async function withShell(
  fn: (shell: AgentShell, cwd: string) => Promise<void>,
): Promise<void> {
  const available = await agentShellAvailable();
  if (!available) {
    // node-pty not built in this environment — skip without failing CI.
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "deyin-agent-shell-"));
  const chunks: string[] = [];
  const shell = new AgentShell({
    cwd,
    events: {
      onData: (_id, data) => {
        chunks.push(data);
      },
      onExit: () => undefined,
    },
  });
  try {
    await shell.ensureStarted();
    await fn(shell, cwd);
  } finally {
    shell.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}

test(
  "runs a command and reports exit codes; strips OSC markers from output",
  { skip: !isPosix },
  async () => {
    await withShell(async (shell) => {
      const ok = await shell.run("echo hello-agent", { timeoutS: 10 });
      assert.ok(ok.output.includes("hello-agent"), `got: ${ok.output}`);
      assert.equal(ok.exitCode, 0);
      assert.ok(!ok.output.includes("6969"), "OSC markers must be stripped");

      // Use a subshell so `exit` does not kill the persistent agent shell.
      const fail = await shell.run("echo boom >&2; (exit 3)", { timeoutS: 10 });
      assert.ok(fail.output.includes("boom"), `got: ${fail.output}`);
      assert.equal(fail.exitCode, 3);
      assert.ok(fail.output.includes("(exit code 3)"));
    });
  },
);

test("cwd persists across calls via cd", { skip: !isPosix }, async () => {
  await withShell(async (shell, cwd) => {
    const sub = join(cwd, "nested");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(sub);

    const first = await shell.run("pwd", { timeoutS: 10 });
    assert.ok(first.output.includes(cwd), `expected cwd in ${first.output}`);

    const moved = await shell.run("pwd", { cwd: sub, timeoutS: 10 });
    assert.ok(moved.output.includes("nested"), `expected nested cwd, got: ${moved.output}`);

    // Subsequent call without cwd keeps the new directory.
    const stayed = await shell.run("pwd", { timeoutS: 10 });
    assert.ok(stayed.output.includes("nested"), `expected persistence, got: ${stayed.output}`);
  });
});

test("streams onData chunks while running", { skip: !isPosix }, async () => {
  await withShell(async (shell) => {
    const deltas: string[] = [];
    const result = await shell.run("printf 'a'; sleep 0.2; printf 'b'", {
      timeoutS: 10,
      onData: (d) => deltas.push(d),
    });
    assert.ok(result.output.includes("a") && result.output.includes("b"));
    assert.ok(deltas.length > 0, "expected live onData callbacks");
    assert.ok(!deltas.join("").includes("\x1b]6969"), "deltas must be marker-stripped");
  });
});

test("timeout interrupts and may recycle the shell", { skip: !isPosix }, async () => {
  await withShell(async (shell) => {
    const result = await shell.run("sleep 30", { timeoutS: 1 });
    assert.ok(result.output.includes("timed out"), `got: ${result.output}`);

    // Shell should still accept a follow-up command (possibly after recycle).
    const next = await shell.run("echo recovered", { timeoutS: 10 });
    assert.ok(next.output.includes("recovered"), `got: ${next.output}`);
  });
});

test("timeout and abort together still recover for the next run", { skip: !isPosix }, async () => {
  await withShell(async (shell) => {
    const ac = new AbortController();
    const pending = shell.run("sleep 30", { timeoutS: 1, signal: ac.signal });
    // Fire cancel while the timeout path is also armed — only one interrupt may recycle.
    setTimeout(() => ac.abort(), 200);
    const result = await pending;
    assert.ok(
      result.output.includes("timed out") || result.output.includes("cancelled"),
      `got: ${result.output}`,
    );

    const next = await shell.run("echo recovered", { timeoutS: 10 });
    assert.ok(next.output.includes("recovered"), `got: ${next.output}`);
  });
});

test("dispose during a running command settles and rejects further runs", { skip: !isPosix }, async () => {
  const available = await agentShellAvailable();
  if (!available) return;
  const cwd = mkdtempSync(join(tmpdir(), "deyin-agent-shell-"));
  const exits: number[] = [];
  const shell = new AgentShell({
    cwd,
    events: {
      onData: () => undefined,
      onExit: (_id, code) => {
        exits.push(code);
      },
    },
  });
  try {
    await shell.ensureStarted();
    const pending = shell.run("sleep 30", { timeoutS: 10 });
    await new Promise((r) => setTimeout(r, 100));
    shell.dispose();
    const result = await Promise.race([
      pending,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("run did not settle after dispose")), 5_000)),
    ]);
    assert.equal(result.exitCode, null);
    assert.ok(exits.length >= 1, "dispose should emit a real termExit");
    await assert.rejects(() => shell.run("echo should-fail", { timeoutS: 5 }), /disposed/);
  } finally {
    shell.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scrollback ring buffer is non-empty after commands", { skip: !isPosix }, async () => {
  await withShell(async (shell) => {
    await shell.run("echo scrollback-test", { timeoutS: 10 });
    assert.ok(shell.getScrollback().length > 0);
  });
});
