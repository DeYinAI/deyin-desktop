import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import type { ToolContext, ToolDefinition } from "../types.js";
import { asOptionalNumber, asOptionalString, asString, resolvePath, truncate } from "./util.js";

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

/** A working directory that lives inside a WSL2 distro. */
export interface WslLocation {
  /** The distro to run in, e.g. "Ubuntu-22.04". */
  distro: string;
  /** POSIX path inside the distro, e.g. "/home/user/project". */
  linuxPath: string;
}

/**
 * Detect a WSL2 UNC working directory. When a Windows-hosted app opens a folder
 * that lives inside a WSL2 distro, the native folder picker returns a
 * `\\wsl$\<distro>\…` (older Windows) or `\\wsl.localhost\<distro>\…` (Win11)
 * path. Recognizing it lets the agent run commands in that same distro — the
 * WSL2 userland the integrated terminal uses — instead of Windows cmd.exe.
 * Returns null for native Windows (`C:\…`) and POSIX paths.
 */
export function parseWslPath(cwd: string): WslLocation | null {
  const match = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]+([^\\/]+)(?:[\\/]+([\s\S]*))?$/i.exec(cwd);
  if (!match) return null;
  const rest = (match[2] ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return { distro: match[1]!, linuxPath: `/${rest}` };
}

/** Single-quote a value for safe interpolation into a POSIX shell command. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** First matching executable on PATH, or null. */
function findOnPath(exe: string): string | null {
  const sep = platform() === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(sep)) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  return null;
}

let cachedPowerShell: string | undefined;

/**
 * The Windows shell for agent commands: PowerShell 7 (`pwsh.exe`) when it is on
 * PATH — it supports `&&`/`||` and modern piping — otherwise Windows PowerShell
 * (`powershell.exe`, always present). Resolved once and cached.
 */
function windowsPowerShell(): string {
  if (cachedPowerShell === undefined) cachedPowerShell = findOnPath("pwsh.exe") ?? "powershell.exe";
  return cachedPowerShell;
}

/**
 * Human label for the shell the bash tool will run commands through, shown in
 * the system prompt so the model uses the right syntax. Reflects WSL2 routing
 * when the cwd lives inside a distro (`\\wsl$\<distro>\…`), PowerShell on native
 * Windows, and bash on POSIX.
 */
export function effectiveShell(cwd?: string): string {
  if (platform() === "win32") {
    const wsl = cwd ? parseWslPath(cwd) : null;
    if (wsl) return `wsl.exe -d ${wsl.distro} (bash)`;
    return windowsPowerShell();
  }
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/** Platform-specific tool description so the model emits the right shell syntax. */
function bashToolDescription(): string {
  if (platform() === "win32") {
    return (
      "Run a shell command in the workspace and return its combined output. On native Windows the " +
      "command runs in PowerShell (use PowerShell/Windows syntax); when the project lives inside a " +
      "WSL2 distro it runs in that distro's bash (use Unix syntax). Working directory and environment " +
      "persist across calls in the same chat. Interactive commands block until they finish or time " +
      "out — prefer non-interactive flags. Prefer the read/write/edit/grep/glob tools for file " +
      "operations. Combine related checks with && / ; in one call when order matters."
    );
  }
  return (
    "Run a shell command in the workspace via a persistent bash session (when the host provides " +
    "one) or a one-shot bash spawn otherwise, and return its combined output. Use for builds, tests, " +
    "git, package managers and anything else with a CLI. Working directory and environment persist " +
    "across calls in the same chat. Interactive commands block until they finish or time out — " +
    "prefer non-interactive flags. Prefer the read/write/edit/grep/glob tools for file operations. " +
    "Combine related checks with && in one call when order matters."
  );
}

interface ShellInvocation {
  file: string;
  args: string[];
  /** cwd to spawn from; undefined inherits the parent (WSL: `\\wsl$` UNC paths
   *  are not valid CreateProcess cwds, so we cd inside the distro instead). */
  spawnCwd?: string;
  /** Extra env merged over process.env for this invocation. */
  env?: Record<string, string>;
}

function shellFor(command: string, cwd: string): ShellInvocation {
  if (platform() === "win32") {
    // A project inside WSL2 (a \\wsl$ path) runs in its distro, matching the
    // integrated terminal; a native Windows path runs in PowerShell.
    const wsl = parseWslPath(cwd);
    if (wsl) {
      const script = `cd ${shQuote(wsl.linuxPath)} && ${command}`;
      return {
        file: "wsl.exe",
        args: ["-d", wsl.distro, "bash", "-c", script],
        // Share the agent marker into the distro so dotfiles can detect it.
        env: { WSLENV: process.env.WSLENV ? `${process.env.WSLENV}:DEYIN_AGENT` : "DEYIN_AGENT" },
      };
    }
    return {
      file: windowsPowerShell(),
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      spawnCwd: cwd,
    };
  }
  // Always POSIX sh/bash for tool commands: the user's login shell may be fish/nushell
  // whose syntax differs from what models emit.
  const bash = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  return { file: bash, args: ["-c", command], spawnCwd: cwd };
}

async function runCommand(command: string, cwd: string, timeoutS: number, signal?: AbortSignal): Promise<string> {
  const { file, args, spawnCwd, env: extraEnv } = shellFor(command, cwd);
  const posix = platform() !== "win32";
  return new Promise((resolvePromise) => {
    // detached on POSIX gives the shell its own process group, so timeouts and
    // cancellation kill the whole tree (e.g. a dev server the command started),
    // not just the shell itself. DEYIN_AGENT=1 lets dotfiles detect agent shells
    // (skip heavy prompts/banners), mirroring Cursor's CURSOR_AGENT.
    const child = spawn(file, args, {
      cwd: spawnCwd,
      env: { ...process.env, DEYIN_AGENT: "1", ...extraEnv },
      windowsHide: true,
      detached: posix,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;

    const killTree = (): void => {
      if (posix && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // group already gone or not a leader; fall back to the child itself
        }
      }
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutS * 1000);

    const onAbort = (): void => {
      cancelled = true;
      killTree();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

    const finalize = (exitCode: number | null, err?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      let out = truncate(stdout);
      if (stderr.trim().length > 0) out += `${out ? "\n" : ""}[stderr]\n${truncate(stderr, 10_000)}`;
      if (timedOut) out += `\n(command timed out after ${timeoutS}s and was killed)`;
      else if (cancelled) out += "\n(command cancelled by the user)";
      else if (err) out += `\n(spawn error: ${err.message})`;
      else if (exitCode !== null && exitCode !== 0) out += `\n(exit code ${exitCode})`;
      resolvePromise(out || "(no output)");
    };

    child.on("error", (err) => finalize(null, err));
    child.on("close", (code) => finalize(code));
  });
}

function runBackgroundCommand(
  command: string,
  cwd: string,
): Promise<{ output: string; exitCode: number | null }> {
  const { file, args, spawnCwd, env: extraEnv } = shellFor(command, cwd);
  const posix = platform() !== "win32";
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: spawnCwd,
      env: { ...process.env, DEYIN_AGENT: "1", ...extraEnv },
      windowsHide: true,
      detached: posix,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => resolve({ output: `spawn error: ${err.message}`, exitCode: null }));
    child.on("close", (code) => {
      let out = truncate(stdout);
      if (stderr.trim().length > 0) out += `${out ? "\n" : ""}[stderr]\n${truncate(stderr, 10_000)}`;
      resolve({ output: out || "(no output)", exitCode: code });
    });
    child.unref();
  });
}

export const bashTool: ToolDefinition = {
  name: "bash",
  description: bashToolDescription(),
  tier: "execute",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      cwd: { type: "string", description: "Working directory (defaults to the workspace root)." },
      timeout_seconds: {
        type: "number",
        description: `Kill the command after this many seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`,
      },
      block_until_ms: {
        type: "number",
        description:
          "Milliseconds to wait before returning. Set to 0 to run in the background and return a task_id for the await tool.",
      },
    },
    required: ["command"],
  },
  summarize: (args) => String(args.command ?? "").split("\n")[0]?.slice(0, 120) ?? "",
  meta: (args, ctx) => ({
    cwd: asOptionalString(args.cwd) ? resolvePath(ctx.cwd, String(args.cwd)) : ctx.cwd,
  }),
  async execute(args, ctx: ToolContext): Promise<string> {
    const command = asString(args.command, "command");
    const cwd = asOptionalString(args.cwd) ? resolvePath(ctx.cwd, String(args.cwd)) : ctx.cwd;
    const blockUntilMs = asOptionalNumber(args.block_until_ms);
    if (blockUntilMs === 0) {
      if (!ctx.registerBackgroundTask) {
        return "ERROR: background bash tasks are not supported in this environment.";
      }
      const taskId = randomUUID();
      const promise = runBackgroundCommand(command, cwd);
      ctx.registerBackgroundTask(taskId, promise);
      return `Background task started.\ntask_id: ${taskId}\nUse the await tool to poll for completion.`;
    }

    const timeoutS = Math.min(asOptionalNumber(args.timeout_seconds) ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);

    if (ctx.shell) {
      try {
        const result = await ctx.shell.run(command, {
          cwd,
          timeoutS,
          signal: ctx.signal,
          onData: ctx.onOutput,
        });
        return truncate(result.output);
      } catch (err) {
        // Only fall through to one-shot spawn when the PTY itself cannot be
        // created (no node-pty, no bash on POSIX). A mid-run failure (timeout,
        // cancel, write to a dead PTY) must NOT re-exec the command — that
        // would double side effects. Surface it as an error result instead.
        if (isShellUnavailable(err)) {
          // Fall through to spawn below.
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          return `ERROR: shell command failed: ${msg}`;
        }
      }
    }

    return runCommand(command, cwd, timeoutS, ctx.signal);
  },
};

function isShellUnavailable(err: unknown): boolean {
  if (err && typeof err === "object") {
    const name = (err as { name?: string }).name;
    const code = (err as { code?: string }).code;
    if (name === "ShellUnavailableError") return true;
    if (code === "SHELL_UNAVAILABLE") return true;
  }
  return false;
}
