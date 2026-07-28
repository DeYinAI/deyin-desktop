import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import type { ToolContext, ToolDefinition } from "../types.js";
import { asOptionalNumber, asOptionalString, asString, resolvePath, truncate } from "./util.js";

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

function shellFor(command: string): { file: string; args: string[] } {
  if (platform() === "win32") {
    return { file: process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  // Always POSIX sh/bash for tool commands: the user's login shell may be fish/nushell
  // whose syntax differs from what models emit.
  const bash = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  return { file: bash, args: ["-c", command] };
}

async function runCommand(command: string, cwd: string, timeoutS: number, signal?: AbortSignal): Promise<string> {
  const { file, args } = shellFor(command);
  const posix = platform() !== "win32";
  return new Promise((resolvePromise) => {
    // detached on POSIX gives the shell its own process group, so timeouts and
    // cancellation kill the whole tree (e.g. a dev server the command started),
    // not just the shell itself. DEYIN_AGENT=1 lets dotfiles detect agent shells
    // (skip heavy prompts/banners), mirroring Cursor's CURSOR_AGENT.
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, DEYIN_AGENT: "1" },
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

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a shell command in the workspace and return its combined output. Use for builds, tests, git, package managers and anything else with a CLI. Commands run non-interactively (no TTY); avoid commands that wait for input. Prefer the read/write/edit/grep/glob tools for file operations.",
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
    },
    required: ["command"],
  },
  summarize: (args) => String(args.command ?? "").split("\n")[0]?.slice(0, 120) ?? "",
  async execute(args, ctx: ToolContext): Promise<string> {
    const command = asString(args.command, "command");
    const cwd = asOptionalString(args.cwd) ? resolvePath(ctx.cwd, String(args.cwd)) : ctx.cwd;
    const timeoutS = Math.min(asOptionalNumber(args.timeout_seconds) ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);
    return runCommand(command, cwd, timeoutS, ctx.signal);
  },
};
