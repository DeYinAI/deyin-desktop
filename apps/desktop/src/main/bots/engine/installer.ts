import { BotError, type EngineStatus, type EngineSupervisor } from "@deyin/host-core";
import {
  ENABLE_LINGER_SCRIPT,
  INSTALL_CLI_SCRIPT,
  PROBE_SCRIPT,
  diagnosticsScript,
  enginePaths,
  launcherScript,
  loginScript,
  parseProbe,
  parseSignInPrompt,
  removeCronScript,
  startNohupScript,
  startSystemdScript,
  stopNohupScript,
  stopSystemdScript,
  stripAnsi,
  systemdUnit,
  uninstallScript,
  whoamiScript,
  writeKeyScript,
  type LaunchOptions,
  type ServerProbe,
  type SignInPrompt,
} from "./install-scripts.js";

/** A shell on the server. The installer sends it scripts; over SSH each runs in a login shell. */
export interface RemoteShell {
  run(script: string, options?: RemoteRunOptions): Promise<RemoteRunResult>;
}

export interface RemoteRunOptions {
  /** Written to the script's standard input, then closed. */
  stdin?: string;
  signal?: AbortSignal;
  /** Called with each piece of output as it arrives. */
  onOutput?: (chunk: string) => void;
}

export interface RemoteRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const INSTALL_STEPS = ["probe", "cli", "sign-in", "key", "start", "verify"] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number];

export interface InstallProgress {
  step: InstallStep;
  state: "running" | "done" | "skipped";
  /** What is happening or happened, in words a person reads. */
  message: string;
}

export interface InstallRegistration {
  port: number;
  token: string;
  supervisor: EngineSupervisor;
  survivesReboot: boolean;
}

export interface InstallOptions {
  shell: RemoteShell;
  /** The engine's key: a new one the first time, the stored one on a re-run. */
  token: string;
  port: number;
  onProgress: (progress: InstallProgress) => void;
  /** Called when the server is not signed in and needs the person to approve a sign-in in a browser. */
  onSignIn: (prompt: SignInPrompt) => void;
  /** Record the engine so it can be reached; called once it is running and before it is checked. */
  register: (registration: InstallRegistration) => void;
  /** Ask the engine, through the usual connection, how it is. Throws until it answers. */
  verify: () => Promise<EngineStatus>;
  signal?: AbortSignal;
  /** How long to keep asking the engine to answer, and how often. */
  verifyAttempts?: number;
  verifyIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface InstallResult {
  version: string;
  deyinVersion: string;
  supervisor: EngineSupervisor;
  survivesReboot: boolean;
  /** Things that work but a person should know, e.g. the engine will not come back after a reboot. */
  warnings: string[];
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The tail of a program's output for an error message: no colour codes, no blank lines, bounded. */
export function tailOf(text: string, lines = 8, maxChars = 800): string {
  const kept = stripAnsi(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-lines)
    .join("\n");
  return kept.length > maxChars ? `…${kept.slice(-maxChars)}` : kept;
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BotError("conflict", "Setup was stopped.");
}

async function mustRun(shell: RemoteShell, script: string, what: string, options: RemoteRunOptions = {}): Promise<RemoteRunResult> {
  const result = await shell.run(script, options);
  aborted(options.signal);
  if (result.code !== 0) {
    const detail = tailOf(result.stderr) || tailOf(result.stdout);
    throw new BotError("conflict", `${what} failed on the server (exit ${result.code})${detail ? `:\n${detail}` : "."}`);
  }
  return result;
}

async function probe(shell: RemoteShell, signal: AbortSignal | undefined): Promise<ServerProbe> {
  const result = await shell.run(PROBE_SCRIPT, { signal });
  aborted(signal);
  if (result.code !== 0) throw new BotError("conflict", `The server did not run the check script (exit ${result.code}). It needs bash.`);
  return parseProbe(result.stdout);
}

/** Whether the server's `deyin` is signed in. `whoami` exits 0 when signed in, 1 when signed in but the profile could not be fetched, 2 when not. */
async function signedIn(shell: RemoteShell, deyin: string, signal: AbortSignal | undefined): Promise<boolean> {
  const result = await shell.run(whoamiScript(deyin), { signal });
  aborted(signal);
  if (result.code === 0 || result.code === 1) return true;
  if (result.code === 2) return false;
  throw new BotError("conflict", `Could not check whether deyin is signed in on the server (exit ${result.code}).`);
}

/**
 * Put the Bot engine on a server and make sure it is running, step by step. Every step can be run again: a second run
 * keeps what is right, rewrites what it owns and restarts the engine. Nothing here is specific to SSH; it all goes
 * through `shell`.
 */
export async function installEngine(options: InstallOptions): Promise<InstallResult> {
  const { shell, signal } = options;
  const warnings: string[] = [];
  const progress = (step: InstallStep, state: InstallProgress["state"], message: string): void => options.onProgress({ step, state, message });

  /* 1. What is there --------------------------------------------------------- */
  progress("probe", "running", "Checking the server");
  aborted(signal);
  let server = await probe(shell, signal);
  progress("probe", "done", `${server.user} on ${server.os} ${server.arch}`);

  /* 2. The deyin command ------------------------------------------------------ */
  if (server.deyin && server.botEngine) {
    progress("cli", "skipped", `deyin ${server.deyinVersion ?? ""} is already installed`.trim());
  } else {
    progress("cli", "running", server.deyin ? "Updating deyin on the server" : "Installing deyin on the server");
    if (!server.curl) {
      throw new BotError("conflict", `deyin ${server.deyin ? "needs updating" : "is not installed"} on the server, and this server has no curl to do it with. Install deyin there (https://cdn.deyin.ai/cli/install.sh) and try again.`);
    }
    await mustRun(shell, INSTALL_CLI_SCRIPT, "Installing deyin", { signal });
    server = await probe(shell, signal);
    if (!server.deyin) throw new BotError("conflict", "deyin was installed on the server but cannot be found there. Add its folder to the server's PATH and try again.");
    if (!server.botEngine) {
      throw new BotError("conflict", `The newest deyin (${server.deyinVersion ?? "unknown version"}) does not include the Bot engine yet. Update deyin on the server when a release with the Bot engine is out.`);
    }
    progress("cli", "done", `deyin ${server.deyinVersion ?? ""} is ready`.trim());
  }
  const deyin = server.deyin;
  if (!deyin) throw new BotError("conflict", "deyin cannot be found on the server.");

  /* 3. Sign in on the server -------------------------------------------------- */
  if (await signedIn(shell, deyin, signal)) {
    progress("sign-in", "skipped", "deyin is signed in on the server");
  } else {
    progress("sign-in", "running", "deyin needs you to sign in on the server");
    let seen = "";
    let shown = false;
    const result = await shell.run(loginScript(deyin), {
      signal,
      onOutput: (chunk) => {
        seen += chunk;
        if (shown) return;
        const prompt = parseSignInPrompt(seen);
        if (prompt) {
          shown = true;
          options.onSignIn(prompt);
        }
      },
    });
    aborted(signal);
    if (result.code !== 0) {
      const detail = tailOf(result.stderr) || tailOf(result.stdout);
      throw new BotError("conflict", `Signing in on the server did not finish (exit ${result.code})${detail ? `:\n${detail}` : "."}`);
    }
    if (!(await signedIn(shell, deyin, signal))) throw new BotError("conflict", "The server still is not signed in after the sign-in finished.");
    progress("sign-in", "done", "Signed in on the server");
  }

  /* 4. The key ----------------------------------------------------------------- */
  const paths = enginePaths(server.home);
  progress("key", "running", "Placing the engine's key");
  await mustRun(shell, writeKeyScript(paths), "Placing the key", { stdin: options.token, signal });
  progress("key", "done", "The key is in place, readable only by you");

  /* 5. Start it ---------------------------------------------------------------- */
  progress("start", "running", "Starting the engine");
  const launch: LaunchOptions = { deyin, port: options.port, path: server.path, paths };
  let supervisor: EngineSupervisor = "nohup";
  let survivesReboot: boolean;
  if (server.systemdUser) {
    const linger = server.linger || /linger=1/.test((await shell.run(ENABLE_LINGER_SCRIPT, { signal })).stdout);
    aborted(signal);
    if (linger) supervisor = "systemd";
    else warnings.push("This server would stop the engine when you log out of it, so the engine runs on its own instead. To keep it as a system service, run `sudo loginctl enable-linger " + server.user + "` on the server and set the engine up again.");
  }
  if (supervisor === "systemd") {
    await mustRun(shell, stopNohupScript(paths) + removeCronScript(), "Stopping the old engine", { signal });
    await mustRun(shell, startSystemdScript(paths), "Starting the engine service", { stdin: systemdUnit(launch), signal });
    survivesReboot = true;
  } else {
    await mustRun(shell, stopSystemdScript() + stopNohupScript(paths), "Stopping the old engine", { signal });
    await mustRun(shell, startNohupScript(paths, server.crontab), "Starting the engine", { stdin: launcherScript(launch), signal });
    survivesReboot = server.crontab;
    if (!server.crontab) warnings.push("This server has no cron, so the engine will not start again by itself after the server restarts. Open Settings, Servers and set it up again after a restart.");
  }
  progress("start", "done", supervisor === "systemd" ? "Running as a service" : "Running in the background");
  options.register({ port: options.port, token: options.token, supervisor, survivesReboot });

  /* 6. Check it ---------------------------------------------------------------- */
  progress("verify", "running", "Waiting for the engine to answer");
  const attempts = options.verifyAttempts ?? 20;
  const interval = options.verifyIntervalMs ?? 500;
  const sleep = options.sleep ?? wait;
  let status: EngineStatus | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts && !status; attempt += 1) {
    aborted(signal);
    try {
      status = await options.verify();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(interval);
    }
  }
  if (!status) {
    const log = await shell.run(diagnosticsScript(paths, supervisor), { signal }).then((r) => tailOf(r.stdout), () => "");
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new BotError("conflict", `The engine did not answer after it was started: ${reason}${log ? `\nThe engine's log says:\n${log}` : ""}`);
  }
  progress("verify", "done", `Engine ${status.version} is answering`);
  if (!status.agent.found) warnings.push("The engine could not find deyin to run Bots with.");
  else if (!status.agent.signedIn) warnings.push("deyin on the server is not signed in, so Bots cannot run there yet.");

  return { version: status.version, deyinVersion: server.deyinVersion ?? "", supervisor, survivesReboot, warnings };
}

export interface UninstallOptions {
  shell: RemoteShell;
  /** Also delete the Bots' files and routines on the server. */
  purge: boolean;
  signal?: AbortSignal;
}

/** Take the engine off a server. The server's home is asked for, not assumed. */
export async function uninstallEngine(options: UninstallOptions): Promise<void> {
  const { shell, signal } = options;
  aborted(signal);
  const server = await probe(shell, signal);
  await mustRun(shell, uninstallScript(enginePaths(server.home), options.purge), "Removing the engine", { signal });
}
