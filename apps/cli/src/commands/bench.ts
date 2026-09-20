import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineCommand } from "citty";
import { createContext } from "../context.js";
import { errorLine, bold, dim, cyan, green, red, yellow } from "../output.js";
import { filterTasks, formatBenchmarkReport, resolveBenchmarkSuite, runBenchmarkSuite, type BenchmarkSuiteResult } from "../bench/index.js";

export const benchCommand = defineCommand({
  meta: {
    name: "bench",
    description: "Run reproducible task benchmarks against Deyin coding agents",
  },
  args: {
    suite: {
      type: "positional",
      required: false,
      description: "Path to benchmark suite JSON file (or defaults to local suite / built-in)",
    },
    provider: { type: "string", description: "Provider id (or use provider::model in --model)" },
    model: { type: "string", alias: "m", description: "Model id to benchmark" },
    agent: { type: "string", alias: "a", description: "Agent id (e.g. build, plan)" },
    filter: { type: "string", alias: "k", description: "Run only tasks matching this pattern or ID" },
    "max-steps": { type: "string", description: "Cap agent loop steps per task (default 10)" },
    timeout: { type: "string", description: "Timeout per task in seconds (default 120)" },
    output: { type: "string", alias: "o", description: "Save JSON benchmark results to a file" },
    json: { type: "boolean", description: "Output results as JSON to stdout" },
    builtin: { type: "boolean", description: "Force use of the built-in smoke benchmark suite" },
    "keep-workspaces": { type: "boolean", description: "Keep temporary workspace directories for debugging" },
    verbose: { type: "boolean", alias: "v", description: "Verbose task execution logs" },
    cwd: { type: "string", alias: "C", description: "Workspace directory" },
  },
  async run({ args }) {
    const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
    const overrides: Record<string, unknown> = {};
    if (typeof args.provider === "string" && args.provider) overrides.providerId = args.provider;
    if (typeof args.model === "string" && args.model) overrides.model = args.model;
    if (typeof args.agent === "string" && args.agent) overrides.agent = args.agent;

    const ctx = createContext({ cwd, overrides });
    const isJson = Boolean(args.json);

    let suite;
    try {
      suite = resolveBenchmarkSuite(cwd, typeof args.suite === "string" ? args.suite : undefined, Boolean(args.builtin));
    } catch (err) {
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) + "\n");
      } else {
        errorLine(err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    }

    const maxSteps = Number(args["max-steps"]);
    const timeoutSeconds = Number(args.timeout);
    const filter = typeof args.filter === "string" ? args.filter : undefined;
    const tasksToRun = filterTasks(suite.tasks, filter);

    if (!isJson) {
      process.stdout.write(`\n${bold("Deyin Bench")}: ${cyan(suite.name)}\n`);
      if (suite.description) process.stdout.write(dim(`${suite.description}\n`));
      process.stdout.write(dim(`Model: ${ctx.config.providerId}::${ctx.config.model} · Tasks: ${tasksToRun.length}\n\n`));
    }

    const controller = new AbortController();
    const onSigint = (): void => {
      controller.abort();
      process.stderr.write(`\n${yellow("Aborting benchmark run...")}\n`);
    };
    process.on("SIGINT", onSigint);

    let report: BenchmarkSuiteResult;
    try {
      report = await runBenchmarkSuite(suite, ctx, {
        filter,
        maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : undefined,
        timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : undefined,
        keepWorkspaces: Boolean(args["keep-workspaces"]),
        verbose: Boolean(args.verbose),
        signal: controller.signal,
        onTaskStart: (task, index, total) => {
          if (!isJson) {
            process.stdout.write(dim(`[${index}/${total}] `) + `Running ${bold(task.id)}...\n`);
          }
        },
        onTaskDone: (task, res) => {
          if (!isJson) {
            let status = "";
            switch (res.status) {
              case "passed":
                status = green("✔ PASS");
                break;
              case "failed":
                status = red("✖ FAIL");
                break;
              case "timeout":
                status = yellow("⏱ TIMEOUT");
                break;
              case "error":
                status = red("⚠ ERROR");
                break;
              default: {
                const _exhaustive: never = res.status;
                status = String(_exhaustive);
                break;
              }
            }
            const duration = (res.durationMs / 1000).toFixed(1) + "s";
            process.stdout.write(`  ${status} ${task.id} (${duration}, ${res.steps} steps, ${res.tokens.total.toLocaleString()} tokens)\n`);
            if (res.error) {
              process.stdout.write(red(`    └─ Error: ${res.error}\n`));
            }
            if (res.verificationOutput) {
              process.stdout.write(dim(`    └─ Verify: ${res.verificationOutput.split("\n")[0]}\n`));
            }
          }
        },
      });
    } catch (err) {
      if (isJson) {
        process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) + "\n");
      } else {
        errorLine(err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    } finally {
      process.off("SIGINT", onSigint);
    }

    if (isJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(formatBenchmarkReport(report));
    }

    if (typeof args.output === "string" && args.output) {
      const outPath = resolve(cwd, args.output);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
      if (!isJson) {
        process.stdout.write(dim(`Results saved to ${outPath}\n\n`));
      }
    }

    process.exitCode =
      report.summary.total > 0 &&
      report.summary.failed === 0 &&
      report.summary.errors === 0 &&
      report.summary.timeouts === 0
        ? 0
        : 1;
  },
});
