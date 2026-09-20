import type { ToolDefinition } from "../types.js";
import { detectProjectToolchain } from "../project-detect.js";
import { executeShellCommand } from "./bash.js";
import { asOptionalNumber, asOptionalString } from "./util.js";

const DEFAULT_TIMEOUT_S = 90;
const MAX_FAILURE_LINES = 120;

/**
 * Parses test output to extract failure blocks and concise summary metrics.
 */
export function formatTestOutput(output: string, exitCode: number | null, command: string): string {
  const lines = output.split(/\r?\n/);
  const failureLines: string[] = [];
  const summaryLines: string[] = [];

  let inFailureSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Summary lines
    if (
      /Tests?:\s+\d+/i.test(trimmed) ||
      /===+.*(?:passed|failed|error).*===+/i.test(trimmed) ||
      /# (?:pass|fail|tests|duration_ms)/i.test(trimmed) ||
      /test result:\s+(?:ok|FAILED)/i.test(trimmed) ||
      /^(?:PASS|FAIL)\s+/i.test(trimmed) ||
      trimmed.startsWith("Summary:")
    ) {
      summaryLines.push(trimmed);
    }

    // Failure triggers
    if (
      /^(?:not ok|FAIL|FAILED|FAILURE|Error|AssertionError)/i.test(trimmed) ||
      /^(?:--- FAIL|=== FAILURES)/i.test(trimmed) ||
      /failures?:/i.test(trimmed)
    ) {
      inFailureSection = true;
    }

    if (inFailureSection) {
      failureLines.push(line);
      if (failureLines.length >= MAX_FAILURE_LINES) {
        failureLines.push(`... [truncated: showing first ${MAX_FAILURE_LINES} lines of failure details]`);
        break;
      }
    }
  }

  const passed = exitCode === 0;
  const statusLabel = passed ? "PASSED" : "FAILED";
  const summarySection = summaryLines.length > 0 ? `\nSummary:\n${summaryLines.slice(0, 5).join("\n")}` : "";

  if (passed) {
    return `Test Suite ${statusLabel} (exit code 0).\nCommand: ${command}${summarySection}`;
  }

  const failures = failureLines.length > 0
    ? failureLines.join("\n")
    : output.slice(-2500); // Fall back to tail of output if no specific failure blocks matched

  return `Test Suite ${statusLabel} (exit code ${exitCode ?? "killed"}).\nCommand: ${command}${summarySection}\n\nFailures:\n${failures}`;
}

/**
 * Structured test runner tool.
 * Resolves test commands for the current workspace and filters noisy terminal output
 * to return clear pass/fail status, counts, and isolated failure traces.
 */
export const testRunnerTool: ToolDefinition = {
  name: "test_runner",
  description:
    "Run project tests with automated toolchain detection and failure extraction. " +
    "Filters out verbose passing logs and extracts failing tests, stack traces, and assertions. " +
    "Use to verify changes and validate fixes quickly.",
  tier: "execute",
  parameters: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description: "Optional test name, regex pattern, or specific test file path to run (e.g. 'auth.test.ts' or 'test_login').",
      },
      command: {
        type: "string",
        description: "Optional custom test command override (e.g. 'pnpm test -- filter').",
      },
      timeout_seconds: {
        type: "number",
        description: `Max test execution time in seconds (default ${DEFAULT_TIMEOUT_S}, max 300).`,
      },
    },
  },
  summarize: (args) => {
    const f = asOptionalString(args.filter);
    const c = asOptionalString(args.command);
    return c ? `test_runner (${c})` : f ? `test_runner (${f})` : "test_runner";
  },
  async execute(args, ctx): Promise<string> {
    const filter = asOptionalString(args.filter);
    const customCommand = asOptionalString(args.command);
    const timeoutS = Math.min(asOptionalNumber(args.timeout_seconds) ?? DEFAULT_TIMEOUT_S, 300);

    let cmd = customCommand;
    if (!cmd) {
      const toolchain = await detectProjectToolchain(ctx.cwd);
      const baseCmd = toolchain?.commands.test;

      if (baseCmd) {
        if (!filter) {
          cmd = baseCmd;
        } else if (toolchain?.primaryLanguage === "rust") {
          cmd = `${baseCmd} ${filter}`;
        } else if (toolchain?.primaryLanguage === "go") {
          cmd = `go test -run ${filter} ./...`;
        } else if (toolchain?.primaryLanguage === "python") {
          cmd = `${baseCmd} ${filter}`;
        } else if (toolchain?.primaryLanguage === "javascript" || toolchain?.primaryLanguage === "typescript") {
          const pm = toolchain.packageManager ?? "npm";
          if (pm === "npm" && !baseCmd.includes(" --")) {
            cmd = `${baseCmd} -- ${filter}`;
          } else {
            cmd = `${baseCmd} ${filter}`;
          }
        } else {
          cmd = `${baseCmd} ${filter}`;
        }
      } else if (toolchain?.primaryLanguage === "rust") {
        cmd = filter ? `cargo test ${filter}` : "cargo test";
      } else if (toolchain?.primaryLanguage === "go") {
        cmd = filter ? `go test -run ${filter} ./...` : "go test ./...";
      } else if (toolchain?.primaryLanguage === "python") {
        cmd = filter ? `pytest ${filter}` : "pytest";
      }
    }

    if (!cmd) {
      return (
        "No test command detected or configured for this workspace. " +
        "Specify the test command using the 'command' argument (e.g. test_runner(command: 'pnpm test'))."
      );
    }

    const res = await executeShellCommand(cmd, ctx.cwd, {
      timeoutS,
      signal: ctx.signal,
      shell: ctx.shell,
      onData: ctx.onOutput,
    });

    return formatTestOutput(res.output, res.exitCode, cmd);
  },
};
