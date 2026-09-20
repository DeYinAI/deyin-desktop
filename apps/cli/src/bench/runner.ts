import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { executeShellCommand, resolvePathInWorkspace, type AgentRunResult } from "@deyin/agent-core";
import { BUILTIN_BENCHMARK_SUITE } from "./builtin-suite.js";
import type {
  BenchmarkRunOptions,
  BenchmarkSuite,
  BenchmarkSuiteResult,
  BenchmarkTask,
  TaskBenchmarkResult,
} from "./types.js";
import type { CliContext } from "../context.js";
import { createContext, flushCliStorage } from "../context.js";
import { EXIT_AUTH, EXIT_INTERRUPT, runHeadless } from "../headless.js";
import { bold, dim, gray, green, red, yellow } from "../output.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_STEPS = 10;

/**
 * Validate that a parsed object adheres to the BenchmarkSuite schema.
 */
export function assertBenchmarkSuite(data: unknown): asserts data is BenchmarkSuite {
  if (!data || typeof data !== "object") {
    throw new Error("Benchmark suite must be a JSON object.");
  }
  const suite = data as Partial<BenchmarkSuite>;
  if (typeof suite.name !== "string" || !suite.name.trim()) {
    throw new Error("Benchmark suite must have a valid 'name' string.");
  }
  if (!Array.isArray(suite.tasks)) {
    throw new Error("Benchmark suite must have a 'tasks' array.");
  }
  for (let i = 0; i < suite.tasks.length; i++) {
    const task = suite.tasks[i] as Partial<BenchmarkTask> | undefined;
    if (!task || typeof task !== "object") {
      throw new Error(`Benchmark task at index ${i} must be an object.`);
    }
    if (typeof task.id !== "string" || !task.id.trim()) {
      throw new Error(`Benchmark task at index ${i} is missing an 'id'.`);
    }
    if (typeof task.prompt !== "string" || !task.prompt.trim()) {
      throw new Error(`Benchmark task '${task.id}' is missing a 'prompt'.`);
    }
  }
}

/**
 * Resolve or load the benchmark suite to run.
 */
export function resolveBenchmarkSuite(cwd: string, explicitPath?: string, forceBuiltin?: boolean): BenchmarkSuite {
  if (forceBuiltin) {
    return BUILTIN_BENCHMARK_SUITE;
  }

  if (explicitPath) {
    const full = resolve(cwd, explicitPath);
    if (!existsSync(full)) {
      throw new Error(`Benchmark suite file not found: ${full}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      throw new Error(`Invalid JSON in suite file ${full}: ${err instanceof Error ? err.message : String(err)}`);
    }
    assertBenchmarkSuite(parsed);
    return parsed;
  }

  const standardNames = ["benchmarks.json", "deyin-bench.json", ".deyin/benchmarks.json"];
  for (const name of standardNames) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(candidate, "utf8"));
      } catch (err) {
        throw new Error(`Invalid JSON in suite file ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
      }
      assertBenchmarkSuite(parsed);
      return parsed;
    }
  }

  return BUILTIN_BENCHMARK_SUITE;
}

/**
 * Filter tasks in a suite by pattern or substring.
 */
export function filterTasks(tasks: BenchmarkTask[], filter?: string): BenchmarkTask[] {
  if (!filter || !filter.trim()) return tasks;
  const pattern = filter.trim().toLowerCase();
  return tasks.filter((t) => t.id.toLowerCase().includes(pattern) || (t.name && t.name.toLowerCase().includes(pattern)));
}

/**
 * Run a single benchmark task in an isolated workspace directory.
 */
export async function runBenchmarkTask(
  task: BenchmarkTask,
  baseCtx: CliContext,
  options?: BenchmarkRunOptions,
): Promise<TaskBenchmarkResult> {
  const startedAt = Date.now();
  const workspaceDir = mkdtempSync(join(tmpdir(), `deyin-bench-${task.id}-`));

  let status: TaskBenchmarkResult["status"] = "failed";
  let verificationOutput = "";
  let runResult: AgentRunResult | undefined;
  let taskError: string | undefined;

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let capturedOut = "";
  let capturedErr = "";
  stdout.on("data", (chunk: Buffer) => (capturedOut += chunk.toString("utf8")));
  stderr.on("data", (chunk: Buffer) => (capturedErr += chunk.toString("utf8")));

  const timeoutSeconds = task.timeoutSeconds ?? options?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSeconds * 1000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const onParentAbort = (): void => controller.abort();
  if (options?.signal) {
    options.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  // Isolate DEYIN_DATA_DIR to avoid dirtying real user sessions and usage
  const benchDataDir = mkdtempSync(join(tmpdir(), `deyin-bench-data-${task.id}-`));
  const prevDataDir = process.env.DEYIN_DATA_DIR;
  process.env.DEYIN_DATA_DIR = benchDataDir;

  try {
    // 1. Setup workspace files with path traversal security guard
    if (task.setup?.files) {
      for (const [relPath, content] of Object.entries(task.setup.files)) {
        const dest = resolvePathInWorkspace(workspaceDir, relPath);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content, "utf8");
      }
    }

    // 2. Run setup command if present
    if (task.setup?.command) {
      const setupExec = await executeShellCommand(task.setup.command, workspaceDir, {
        timeoutS: Math.min(timeoutSeconds, 30),
        signal: controller.signal,
      });
      if (setupExec.exitCode !== 0) {
        throw new Error(`Setup command failed (exit code ${setupExec.exitCode}): ${setupExec.output}`);
      }
    }

    // 3. Run the agent in the isolated workspace
    const taskCtx = createContext({
      cwd: workspaceDir,
      dataDir: benchDataDir,
      overrides: {
        providerId: baseCtx.config.providerId,
        model: baseCtx.config.model,
        agent: baseCtx.config.agent,
        thinking: baseCtx.config.thinking,
        apiBaseUrl: baseCtx.config.apiBaseUrl,
      },
    });

    const exitCode = await runHeadless({
      ctx: taskCtx,
      prompt: task.prompt,
      yes: true,
      maxSteps: task.maxSteps ?? options?.maxSteps ?? DEFAULT_MAX_STEPS,
      signal: controller.signal,
      stdout,
      stderr,
      getToken: options?.getToken,
      onResult: (res) => {
        runResult = res;
      },
    });

    if (controller.signal.aborted) {
      status = "timeout";
      taskError = `Task exceeded timeout of ${timeoutSeconds}s`;
    } else if (exitCode === EXIT_INTERRUPT) {
      status = "timeout";
      taskError = "Task was interrupted or aborted";
    } else if (exitCode === EXIT_AUTH) {
      status = "error";
      taskError = "Authentication required (not signed in)";
    } else if (runResult === undefined) {
      status = "error";
      taskError = capturedErr.trim() || `Agent run failed to execute (exit code ${exitCode})`;
    } else {
      // 4. Verification phase
      let verificationFailed = false;

      // 4a. Check required files existence with path traversal protection
      if (task.verify?.filesExist) {
        for (const relFile of task.verify.filesExist) {
          const full = resolvePathInWorkspace(workspaceDir, relFile);
          if (!existsSync(full)) {
            verificationFailed = true;
            verificationOutput += `Missing expected file: ${relFile}\n`;
          }
        }
      }

      // 4b. Check file content assertions (substring or regex)
      if (task.verify?.filesContain) {
        for (const [relFile, expected] of Object.entries(task.verify.filesContain)) {
          const full = resolvePathInWorkspace(workspaceDir, relFile);
          if (!existsSync(full)) {
            verificationFailed = true;
            verificationOutput += `Cannot verify contents: file does not exist: ${relFile}\n`;
            continue;
          }
          const content = readFileSync(full, "utf8");
          const expectations = Array.isArray(expected) ? expected : [expected];
          for (const exp of expectations) {
            let matched = content.includes(exp);
            if (!matched) {
              try {
                matched = new RegExp(exp).test(content);
              } catch {
                matched = false;
              }
            }
            if (!matched) {
              verificationFailed = true;
              verificationOutput += `File ${relFile} did not match expected pattern: "${exp}"\n`;
            }
          }
        }
      }

      // 4c. Run verification shell commands
      if (task.verify?.command) {
        const commands = Array.isArray(task.verify.command) ? task.verify.command : [task.verify.command];
        for (const cmd of commands) {
          const verifyExec = await executeShellCommand(cmd, workspaceDir, {
            timeoutS: Math.min(timeoutSeconds, 30),
            signal: controller.signal,
          });
          if (verifyExec.exitCode !== 0) {
            verificationFailed = true;
            verificationOutput += `Verification command failed (exit code ${verifyExec.exitCode}): ${cmd}\nOutput:\n${verifyExec.output}\n`;
          }
        }
      }

      status = verificationFailed ? "failed" : "passed";
    }
  } catch (err) {
    if (controller.signal.aborted) {
      status = "timeout";
      taskError = `Task timed out after ${timeoutSeconds}s`;
    } else {
      status = "error";
      taskError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timeoutId);
    if (options?.signal) {
      options.signal.removeEventListener("abort", onParentAbort);
    }

    try {
      await flushCliStorage();
    } catch {
      // Ignore flush failures
    }

    if (prevDataDir === undefined) {
      delete process.env.DEYIN_DATA_DIR;
    } else {
      process.env.DEYIN_DATA_DIR = prevDataDir;
    }

    try {
      rmSync(benchDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures
    }

    if (!options?.keepWorkspaces) {
      try {
        rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  const tokens = {
    prompt: runResult?.usage.promptTokens ?? 0,
    completion: runResult?.usage.completionTokens ?? 0,
    cached: runResult?.usage.cachedPromptTokens ?? 0,
    total: runResult?.usage.totalTokens ?? 0,
  };

  if (options?.verbose) {
    if (capturedOut.trim()) process.stdout.write(dim(`[${task.id} stdout]\n${capturedOut}\n`));
    if (capturedErr.trim()) process.stderr.write(dim(`[${task.id} stderr]\n${capturedErr}\n`));
  }

  return {
    id: task.id,
    name: task.name,
    status,
    durationMs,
    steps: runResult?.steps ?? 0,
    tokens,
    finishReason: runResult?.reason,
    error: taskError,
    verificationOutput: verificationOutput.trim() || undefined,
    workspaceDir: options?.keepWorkspaces ? workspaceDir : undefined,
  };
}

/**
 * Execute an entire benchmark suite and aggregate results.
 */
export async function runBenchmarkSuite(
  suite: BenchmarkSuite,
  ctx: CliContext,
  options?: BenchmarkRunOptions,
): Promise<BenchmarkSuiteResult> {
  const startedAt = Date.now();
  const tasksToRun = filterTasks(suite.tasks, options?.filter);

  if (tasksToRun.length === 0) {
    throw new Error(
      options?.filter ? `No benchmark tasks matched filter "${options.filter}".` : "Benchmark suite contains no tasks.",
    );
  }

  const results: TaskBenchmarkResult[] = [];
  const totalTokens = { prompt: 0, completion: 0, cached: 0, total: 0 };

  for (let i = 0; i < tasksToRun.length; i++) {
    const task = tasksToRun[i]!;
    options?.onTaskStart?.(task, i + 1, tasksToRun.length);

    const taskResult = await runBenchmarkTask(task, ctx, options);
    results.push(taskResult);

    totalTokens.prompt += taskResult.tokens.prompt;
    totalTokens.completion += taskResult.tokens.completion;
    totalTokens.cached += taskResult.tokens.cached;
    totalTokens.total += taskResult.tokens.total;

    options?.onTaskDone?.(task, taskResult, i + 1, tasksToRun.length);

    if (options?.signal?.aborted) break;
  }

  const totalDurationMs = Date.now() - startedAt;
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const timeouts = results.filter((r) => r.status === "timeout").length;
  const errors = results.filter((r) => r.status === "error").length;
  const passRate = results.length > 0 ? passed / results.length : 0;

  return {
    suiteName: suite.name,
    description: suite.description,
    timestamp: new Date().toISOString(),
    model: ctx.config.model,
    provider: ctx.config.providerId,
    totalDurationMs,
    summary: {
      total: results.length,
      passed,
      failed,
      timeouts,
      errors,
      passRate,
      totalTokens,
    },
    tasks: results,
  };
}

/**
 * Format benchmark results into a clean, human-readable terminal report.
 */
export function formatBenchmarkReport(report: BenchmarkSuiteResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(bold(`Deyin Benchmark Report: ${report.suiteName}`));
  if (report.description) lines.push(dim(report.description));
  lines.push(dim(`Model: ${report.provider}::${report.model} · Tasks: ${report.summary.total}`));
  lines.push("");

  const header = `  Status   Task ID                      Steps    Tokens     Time`;
  lines.push(bold(header));
  lines.push(gray("  " + "─".repeat(header.length - 2)));

  for (const t of report.tasks) {
    let statusLabel = "";
    switch (t.status) {
      case "passed":
        statusLabel = green("✔ PASS  ");
        break;
      case "failed":
        statusLabel = red("✖ FAIL  ");
        break;
      case "timeout":
        statusLabel = yellow("⏱ TIMEOUT");
        break;
      case "error":
        statusLabel = red("⚠ ERROR ");
        break;
      default: {
        const _exhaustive: never = t.status;
        statusLabel = String(_exhaustive);
        break;
      }
    }

    const durationSec = (t.durationMs / 1000).toFixed(1) + "s";
    const displayName = t.name ? `${t.id} (${t.name})` : t.id;
    const taskCol = displayName.slice(0, 26).padEnd(28);
    const stepCol = String(t.steps).padStart(5);
    const tokCol = t.tokens.total.toLocaleString().padStart(9);
    const timeCol = durationSec.padStart(8);

    lines.push(`  ${statusLabel} ${taskCol} ${stepCol} ${tokCol} ${timeCol}`);

    if (t.error) {
      lines.push(red(`    └─ Error: ${t.error}`));
    }
    if (t.verificationOutput) {
      lines.push(dim(`    └─ Verify Output: ${t.verificationOutput.split("\n")[0]}`));
    }
  }

  lines.push(gray("  " + "─".repeat(header.length - 2)));
  lines.push("");
  lines.push(bold("Summary:"));
  const percent = (report.summary.passRate * 100).toFixed(1);
  const colorFn = report.summary.passRate >= 0.8 ? green : report.summary.passRate >= 0.5 ? yellow : red;
  lines.push(`  Pass Rate: ${colorFn(`${report.summary.passed}/${report.summary.total} (${percent}%)`)}`);
  lines.push(`  Duration:  ${(report.totalDurationMs / 1000).toFixed(1)}s`);
  lines.push(
    `  Tokens:    ${report.summary.totalTokens.total.toLocaleString()} total ` +
      dim(`(${report.summary.totalTokens.prompt.toLocaleString()} prompt, ${report.summary.totalTokens.completion.toLocaleString()} completion, ${report.summary.totalTokens.cached.toLocaleString()} cached)`),
  );
  lines.push("");

  return lines.join("\n");
}
