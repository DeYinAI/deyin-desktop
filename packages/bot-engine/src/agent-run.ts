import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { LineSplitter, parseAgentResultLine, runReasonFrom, runTimeout, type EngineRunEnd, type RuntimeRunReason, type RuntimeRunRequest } from "@deyin/host-core";

/** How to start the `deyin` agent: the command and any arguments that come before the ones the engine adds. */
export interface DeyinCommand {
  command: string;
  args: string[];
}

/**
 * Where `deyin` is. The engine is part of `deyin`, so it normally starts a copy of itself. A compiled binary is its
 * own command; under Node the command is Node and the script is the first argument. `override` (the `--deyin` flag or
 * `DEYIN_BIN`) wins, which is what the installer passes so a service does not depend on its PATH.
 */
export function resolveDeyinCommand(options: { override?: string; env?: NodeJS.ProcessEnv; execPath?: string; script?: string } = {}): DeyinCommand {
  const override = options.override?.trim() || options.env?.DEYIN_BIN?.trim();
  if (override) return { command: override, args: [] };
  const execPath = options.execPath ?? process.execPath;
  if (basename(execPath).toLowerCase().startsWith("deyin")) return { command: execPath, args: [] };
  const script = options.script ?? process.argv[1];
  return script ? { command: execPath, args: [script] } : { command: execPath, args: [] };
}

/** The arguments of `deyin run` for a request. `read_only` leaves out `-y`, so anything that would ask is refused. */
export function agentArguments(request: Pick<RuntimeRunRequest, "model" | "mode" | "maxSteps">, filesDir: string): string[] {
  const args = ["run", "--json", "-C", filesDir, "-m", request.model];
  if (request.mode === "run_everything") args.push("-y");
  if (request.maxSteps !== undefined) args.push("--max-steps", String(request.maxSteps));
  return args;
}

export interface AgentRunOptions {
  deyin: DeyinCommand;
  filesDir: string;
  request: RuntimeRunRequest;
  /** Each line the agent prints on stdout, as it comes. */
  onLine: (line: string) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
}

export interface AgentRunOutcome {
  end: EngineRunEnd;
  /** What the agent said last, from its `result` line. */
  finalText: string;
  reason: RuntimeRunReason;
  /** The end of what the agent printed on stderr, for saying why a run failed. */
  stderrTail: string;
}

const STDERR_TAIL = 2_000;

function kill(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Start `deyin run --json` in the Bot's folder with the prompt on stdin, hand on each line it prints, and say how it
 * ended. The prompt goes over stdin and not the command line so it is not in the process list. The run is killed,
 * with its children, at its timeout and when `signal` aborts.
 */
export function runAgent(options: AgentRunOptions): Promise<AgentRunOutcome> {
  const { deyin, filesDir, request, onLine, signal } = options;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ end: { type: "engine-exit", code: null, timedOut: false, aborted: true }, finalText: "", reason: "aborted", stderrTail: "" });
      return;
    }
    let finalText = "";
    let resultReason = "";
    let stderrTail = "";
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let done = false;

    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      for (const line of splitter.end()) handle(line);
      const partial = { timedOut, aborted, ...(spawnError ? { error: spawnError } : {}) };
      const reason: RuntimeRunReason = runReasonFrom(partial, resultReason);
      const tail = stderrTail.trim();
      const end: EngineRunEnd = {
        type: "engine-exit",
        code,
        timedOut,
        aborted,
        ...(spawnError ? { error: spawnError } : {}),
        ...(reason === "failed" && tail ? { stderr: tail } : {}),
      };
      resolve({ end, finalText, reason, stderrTail: stderrTail.trim() });
    };

    const handle = (line: string): void => {
      const result = parseAgentResultLine(line);
      if (result) {
        finalText = result.finalText;
        resultReason = result.reason;
      }
      onLine(line);
    };

    const splitter = new LineSplitter();
    const child = (options.spawnImpl ?? spawn)(deyin.command, [...deyin.args, ...agentArguments(request, filesDir)], {
      cwd: filesDir,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      kill(child);
    }, runTimeout(request));
    const onAbort = (): void => {
      aborted = true;
      kill(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of splitter.push(chunk)) handle(line);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
    });
    child.on("error", (error) => {
      spawnError = `Could not start deyin: ${error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    // A process that dies before reading its input closes the pipe; that is its exit to report, not ours to throw.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(request.prompt);
  });
}
