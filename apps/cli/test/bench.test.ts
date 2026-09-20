import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertBenchmarkSuite,
  filterTasks,
  formatBenchmarkReport,
  resolveBenchmarkSuite,
  runBenchmarkSuite,
  runBenchmarkTask,
  type BenchmarkSuite,
} from "../src/bench/index.js";
import { createContext } from "../src/context.js";
import { startMockOpenAI, textResponse, toolCallResponse } from "./helpers/mock-openai.js";

function makeBenchCtx(apiBaseUrl: string): { ctx: ReturnType<typeof createContext>; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), "deyin-data-bench-"));
  const cwd = mkdtempSync(join(tmpdir(), "deyin-ws-bench-"));
  const previous = process.env.DEYIN_DATA_DIR;
  process.env.DEYIN_DATA_DIR = dataDir;
  const ctx = createContext({ cwd, overrides: { apiBaseUrl, model: "test-model" } });
  if (previous === undefined) delete process.env.DEYIN_DATA_DIR;
  else process.env.DEYIN_DATA_DIR = previous;
  return {
    ctx,
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test("assertBenchmarkSuite validates suite shape and required fields", () => {
  assert.throws(() => assertBenchmarkSuite(null), /must be a JSON object/);
  assert.throws(() => assertBenchmarkSuite({}), /valid 'name'/);
  assert.throws(() => assertBenchmarkSuite({ name: "Suite" }), /'tasks' array/);
  assert.throws(() => assertBenchmarkSuite({ name: "Suite", tasks: [{}] }), /missing an 'id'/);
  assert.throws(() => assertBenchmarkSuite({ name: "Suite", tasks: [{ id: "t1" }] }), /missing a 'prompt'/);

  // Valid suite passes
  assertBenchmarkSuite({
    name: "Valid Suite",
    tasks: [{ id: "t1", prompt: "prompt text" }],
  });
});

test("resolveBenchmarkSuite loads built-in and custom suite files", () => {
  const dir = mkdtempSync(join(tmpdir(), "deyin-suite-test-"));
  try {
    // 1. Defaults to built-in when no file in cwd
    const builtin = resolveBenchmarkSuite(dir);
    assert.ok(builtin.tasks.length >= 3);
    assert.equal(builtin.tasks[0]?.id, "create-math-add");

    // 2. Loads local benchmarks.json
    const customSuite: BenchmarkSuite = {
      name: "Custom Suite",
      tasks: [{ id: "custom-1", prompt: "do something" }],
    };
    writeFileSync(join(dir, "benchmarks.json"), JSON.stringify(customSuite), "utf8");
    const loaded = resolveBenchmarkSuite(dir);
    assert.equal(loaded.name, "Custom Suite");
    assert.equal(loaded.tasks[0]?.id, "custom-1");

    // 3. Explicit path error when not found
    assert.throws(() => resolveBenchmarkSuite(dir, "nonexistent.json"), /not found/);

    // 4. Invalid JSON syntax throws clear error
    writeFileSync(join(dir, "bad.json"), "{ invalid-json }", "utf8");
    assert.throws(() => resolveBenchmarkSuite(dir, "bad.json"), /Invalid JSON in suite file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filterTasks filters by id or name case-insensitively", () => {
  const tasks = [
    { id: "task-add", name: "Add feature", prompt: "p1" },
    { id: "task-fix", name: "Fix bug", prompt: "p2" },
    { id: "task-test", name: "Run tests", prompt: "p3" },
  ];
  assert.equal(filterTasks(tasks, "add").length, 1);
  assert.equal(filterTasks(tasks, "bug").length, 1);
  assert.equal(filterTasks(tasks, "TASK").length, 3);
  assert.equal(filterTasks(tasks, "").length, 3);
  assert.equal(filterTasks(tasks, "nomatch").length, 0);
});

test("runBenchmarkTask rejects path traversal in setup and verify files", async () => {
  const server = await startMockOpenAI(() => textResponse("done"));
  const { ctx, cleanup } = makeBenchCtx(server.url);
  try {
    // Setup traversal attempt
    const taskSetupEscape = {
      id: "setup-escape",
      prompt: "do work",
      setup: {
        files: {
          "../../escaped.txt": "evil content",
        },
      },
    };
    const resSetup = await runBenchmarkTask(taskSetupEscape, ctx, {
      getToken: async () => "test-token",
    });
    assert.equal(resSetup.status, "error");
    assert.ok(resSetup.error?.includes("Path escapes workspace"));

    // Verify traversal attempt
    const taskVerifyEscape = {
      id: "verify-escape",
      prompt: "do work",
      verify: {
        filesExist: ["../../../etc/shadow"],
      },
    };
    const resVerify = await runBenchmarkTask(taskVerifyEscape, ctx, {
      getToken: async () => "test-token",
    });
    assert.equal(resVerify.status, "error");
    assert.ok(resVerify.error?.includes("Path escapes workspace"));
  } finally {
    await server.close();
    cleanup();
  }
});

test("runBenchmarkTask classifies pre-run auth failure as error rather than failed", async () => {
  const server = await startMockOpenAI(() => textResponse("done"));
  const { ctx, cleanup } = makeBenchCtx(server.url);
  try {
    const task = {
      id: "auth-test",
      prompt: "do something",
    };
    // When getToken returns null, runHeadless exits with EXIT_AUTH
    const res = await runBenchmarkTask(task, ctx, {
      getToken: async () => null,
    });
    assert.equal(res.status, "error");
    assert.ok(res.error?.includes("Authentication required"));
  } finally {
    await server.close();
    cleanup();
  }
});

test("runBenchmarkTask runs setup, agent, regex verifications, and reports pass/fail", async () => {
  // Mock model that responds to tool calls
  const server = await startMockOpenAI((reqIdx) => {
    if (reqIdx === 0) {
      return toolCallResponse("call-1", "write", {
        path: "math.js",
        content: "function add(a, b) { return a + b; }\nmodule.exports = { add };\n",
      });
    }
    return textResponse("Created math.js successfully.");
  });

  const { ctx, cleanup } = makeBenchCtx(server.url);
  try {
    const task = {
      id: "math-test",
      prompt: "Create math.js exporting add(a, b)",
      verify: {
        filesExist: ["math.js"],
        filesContain: {
          "math.js": "return\\s+a\\s*\\+\\s*b", // regex test
        },
        command: "node -e \"const { add } = require('./math.js'); if (add(2, 3) !== 5) process.exit(1);\"",
      },
    };

    const res = await runBenchmarkTask(task, ctx, {
      getToken: async () => "test-token",
      timeoutSeconds: 30,
      keepWorkspaces: false,
    });

    assert.equal(res.status, "passed");
    assert.equal(res.id, "math-test");
    assert.ok(res.steps >= 1);
    assert.ok(res.durationMs > 0);
  } finally {
    await server.close();
    cleanup();
  }
});

test("runBenchmarkTask honors keepWorkspaces option", async () => {
  const server = await startMockOpenAI(() => textResponse("noop"));
  const { ctx, cleanup } = makeBenchCtx(server.url);
  try {
    const task = {
      id: "keep-test",
      prompt: "do nothing",
    };
    const res = await runBenchmarkTask(task, ctx, {
      getToken: async () => "test-token",
      keepWorkspaces: true,
    });
    assert.ok(res.workspaceDir);
    assert.ok(existsSync(res.workspaceDir));
    // Clean up manually
    rmSync(res.workspaceDir, { recursive: true, force: true });
  } finally {
    await server.close();
    cleanup();
  }
});

test("runBenchmarkTask detects verification failures", async () => {
  // Model that answers without writing the required file
  const server = await startMockOpenAI(() => textResponse("I will not write the file."));
  const { ctx, cleanup } = makeBenchCtx(server.url);
  try {
    const task = {
      id: "fail-test",
      prompt: "Create missing.txt",
      verify: {
        filesExist: ["missing.txt"],
      },
    };

    const res = await runBenchmarkTask(task, ctx, {
      getToken: async () => "test-token",
      timeoutSeconds: 30,
    });

    assert.equal(res.status, "failed");
    assert.ok(res.verificationOutput?.includes("Missing expected file: missing.txt"));
  } finally {
    await server.close();
    cleanup();
  }
});

test("runBenchmarkSuite throws error on empty tasks or unmatched filter", async () => {
  const server = await startMockOpenAI(() => textResponse("done"));
  const { ctx, cleanup } = makeBenchCtx(server.url);
  try {
    const suiteWithTask: BenchmarkSuite = {
      name: "Empty Filter Suite",
      tasks: [{ id: "task-1", prompt: "p" }],
    };
    await assert.rejects(
      () => runBenchmarkSuite(suiteWithTask, ctx, { filter: "unmatched-filter" }),
      /No benchmark tasks matched filter "unmatched-filter"/,
    );

    const emptySuite: BenchmarkSuite = {
      name: "Empty Tasks Suite",
      tasks: [],
    };
    await assert.rejects(
      () => runBenchmarkSuite(emptySuite, ctx),
      /Benchmark suite contains no tasks/,
    );
  } finally {
    await server.close();
    cleanup();
  }
});

test("runBenchmarkSuite aggregates multiple tasks and generates report", async () => {
  let callCount = 0;
  const server = await startMockOpenAI(() => {
    callCount++;
    return textResponse(`Done step ${callCount}`);
  });

  const { ctx, cleanup } = makeBenchCtx(server.url);
  try {
    const suite: BenchmarkSuite = {
      name: "Aggregation Suite",
      tasks: [
        {
          id: "t1",
          name: "Task 1",
          prompt: "Say done",
        },
        {
          id: "t2",
          name: "Task 2",
          prompt: "Create impossible",
          verify: {
            filesExist: ["never-created.txt"],
          },
        },
      ],
    };

    const report = await runBenchmarkSuite(suite, ctx, {
      getToken: async () => "test-token",
      timeoutSeconds: 15,
    });

    assert.equal(report.suiteName, "Aggregation Suite");
    assert.equal(report.summary.total, 2);
    assert.equal(report.summary.passed, 1);
    assert.equal(report.summary.failed, 1);
    assert.equal(report.summary.passRate, 0.5);

    const formatted = formatBenchmarkReport(report);
    assert.ok(formatted.includes("Deyin Benchmark Report: Aggregation Suite"));
    assert.ok(formatted.includes("Pass Rate:"));
    assert.ok(formatted.includes("t1"));
    assert.ok(formatted.includes("t2"));
  } finally {
    await server.close();
    cleanup();
  }
});
