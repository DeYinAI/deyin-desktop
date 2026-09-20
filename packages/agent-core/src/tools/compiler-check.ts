import type { ToolDefinition } from "../types.js";
import { formatDiagnostics } from "../loop.js";
import { detectProjectToolchain } from "../project-detect.js";
import { executeShellCommand } from "./bash.js";
import { asOptionalNumber, asOptionalString, resolvePathInWorkspace } from "./util.js";

const DEFAULT_TIMEOUT_S = 45;
const MAX_ERROR_LINES = 100;

/**
 * Filter compiler output to keep only lines with errors, warnings, and file locations.
 */
export function extractCompilerErrors(output: string): string {
  const lines = output.split(/\r?\n/);
  const relevant: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Filter out common CLI noise
    if (
      trimmed.startsWith("> ") ||
      trimmed.startsWith("npm error") ||
      trimmed.startsWith("npm ERR!") ||
      trimmed.includes("ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL") ||
      trimmed.startsWith("Scope: ") ||
      trimmed.includes("Done in ")
    ) {
      continue;
    }

    // Keep error/warning lines or file location lines
    if (
      /error|warning|fail|syntaxerror|typeerror|undefined|cannot find|unresolved/i.test(trimmed) ||
      /\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|hpp):\d+/i.test(trimmed) ||
      /-->\s+src\//.test(trimmed)
    ) {
      relevant.push(line);
      if (relevant.length >= MAX_ERROR_LINES) {
        relevant.push(`... [truncated: showing first ${MAX_ERROR_LINES} error lines]`);
        break;
      }
    }
  }

  return relevant.length > 0 ? relevant.join("\n") : output.slice(0, 3000);
}

/**
 * Tool for running compiler and typecheck verification.
 * Automatically detects project compiler (tsc, cargo check, go vet, mypy)
 * and can query LSP diagnostics when available.
 */
export const checkCompilerErrorsTool: ToolDefinition = {
  name: "check_compiler_errors",
  description:
    "Check for compilation, typecheck, or syntax errors across the workspace or a specific file. " +
    "Uses active language-server diagnostics when available, or executes the project's typechecker " +
    "(e.g., tsc --noEmit, cargo check, go vet, mypy).",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional file or directory path to check.",
      },
      command: {
        type: "string",
        description: "Optional custom compile or typecheck command to run (e.g. 'npm run typecheck').",
      },
      timeout_seconds: {
        type: "number",
        description: `Max timeout in seconds (default ${DEFAULT_TIMEOUT_S}).`,
      },
    },
  },
  summarize: (args) => {
    const p = asOptionalString(args.path);
    const c = asOptionalString(args.command);
    return c ? `check compiler (${c})` : p ? `check compiler: ${p}` : "check compiler errors";
  },
  async execute(args, ctx): Promise<string> {
    const targetPath = asOptionalString(args.path);
    const customCommand = asOptionalString(args.command);
    const timeoutS = Math.min(asOptionalNumber(args.timeout_seconds) ?? DEFAULT_TIMEOUT_S, 120);

    // 1. Try LSP / compiler diagnostics if host provides it
    if (ctx.getDiagnostics && !customCommand) {
      try {
        const paths = targetPath ? [resolvePathInWorkspace(ctx.cwd, targetPath)] : undefined;
        const diags = await ctx.getDiagnostics(paths);
        const errorDiags = diags?.filter((d) => d.severity === "error") ?? [];
        if (errorDiags.length > 0) {
          return `Compiler / LSP diagnostics detected errors:\n${formatDiagnostics(errorDiags)}`;
        }
        if (diags && diags.length > 0) {
          return `Compiler / LSP diagnostics found ${diags.length} diagnostic message(s):\n${formatDiagnostics(diags)}`;
        }
        return targetPath
          ? `No compiler or diagnostic errors found in "${targetPath}".`
          : "No compiler or diagnostic errors found in the workspace.";
      } catch {
        // Fall back to CLI execution
      }
    }

    // 2. Resolve compile command
    let cmd = customCommand;
    if (!cmd) {
      const toolchain = await detectProjectToolchain(ctx.cwd);
      if (toolchain?.commands.typecheck) {
        cmd = toolchain.commands.typecheck;
      } else if (toolchain?.primaryLanguage === "rust") {
        cmd = "cargo check";
      } else if (toolchain?.primaryLanguage === "go") {
        cmd = "go vet ./...";
      } else if (toolchain?.primaryLanguage === "typescript") {
        cmd = "npx tsc --noEmit";
      } else if (toolchain?.primaryLanguage === "python") {
        cmd = "mypy .";
      } else if (toolchain?.primaryLanguage === "java") {
        cmd = "mvn compile -DskipTests";
      }
    }

    if (!cmd) {
      return (
        "No compiler or typechecker command configured or detected for this workspace. " +
        "Specify the command parameter (e.g. check_compiler_errors(command: 'pnpm run typecheck'))."
      );
    }

    // 3. Execute the compiler command
    const res = await executeShellCommand(cmd, ctx.cwd, {
      timeoutS,
      signal: ctx.signal,
      shell: ctx.shell,
      onData: ctx.onOutput,
    });

    if (res.exitCode === 0) {
      return `Compiler check passed successfully (${cmd}).\nNo compiler or typecheck errors found.`;
    }

    const filtered = extractCompilerErrors(res.output);
    return `Compiler check failed with exit code ${res.exitCode} (${cmd}):\n\n${filtered}`;
  },
};
