import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { findPwsh, resolveShellInfo } from "./env.js";
import type { TerminalEvents } from "./pty.js";
import { toWslPath, windowsSpawnCwd } from "./wsl-path.js";

interface IPty {
  /** Session-leader pid of the spawned shell; also its process-group id. */
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface PtyModule {
  spawn(file: string, args: string[], opts: Record<string, unknown>): IPty;
}

/** Thrown when the persistent PTY cannot be created (no node-pty, no bash on POSIX). */
export class ShellUnavailableError extends Error {
  readonly code = "SHELL_UNAVAILABLE" as const;
  constructor(message = "Agent shell unavailable") {
    super(message);
    this.name = "ShellUnavailableError";
  }
}

/** OSC 6969 markers (VS Code shell-integration style) delimit agent command capture. */
const BEGIN_MARKER = "\x1b]6969;b\x07";
const END_MARKER_RE = /\x1b\]6969;e;(-?\d+)\x07/;
const ANY_MARKER_RE = /\x1b\]6969;[be](?:;-?\d+)?\x07/g;
/** CSI / OSC noise (bracketed-paste, title, colors) stripped from model-facing output. */
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[a-zA-Z]|\([0-9A-Za-z])/g;

const SCROLLBACK_CAP = 256 * 1024;
/** One-shot spawn sync (marker install + sentinel echo). */
const SPAWN_SYNC_TIMEOUT_MS = 8_000;
/** Prompt wait during command interrupt / post-spawn cd. */
const READY_TIMEOUT_MS = 15_000;
const INTERRUPT_GRACE_MS = 2_000;
/** Brief pause after PTY spawn so login banners finish before PS0/PS1 setup. */
const SPAWN_BANNER_MS = 100;
/** Grace after SIGHUP before the PTY's whole process group is SIGKILLed. */
const PTY_FORCE_KILL_MS = 500;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

export interface AgentShellRunOptions {
  /** Absolute cwd for this call; emitted as `cd` when it differs from the last known cwd. */
  cwd?: string;
  timeoutS: number;
  signal?: AbortSignal;
  /** Live output chunks with OSC markers stripped (for chat tool cards). */
  onData?: (delta: string) => void;
}

export interface AgentShellRunResult {
  output: string;
  exitCode: number | null;
  /** True when the PTY was killed and respawned (environment reset; cwd restored). */
  restarted?: boolean;
}

export interface AgentShellOptions {
  /** Initial working directory. */
  cwd: string;
  /** Push raw PTY bytes to the renderer (same path as interactive terminals). */
  events: TerminalEvents;
  cols?: number;
  rows?: number;
  /** Optional stable id; defaults to a fresh UUID. */
  id?: string;
  /** Shell id from `EnvInfo.shells` (e.g. `wsl:Ubuntu-22.04`); omit for host default. */
  shell?: string;
}

let ptyModule: PtyModule | null | undefined;

async function loadPty(): Promise<PtyModule | null> {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = (await import("node-pty")) as unknown as PtyModule;
  } catch {
    ptyModule = null;
  }
  return ptyModule;
}

/** True when node-pty can be loaded and a usable agent shell binary exists. */
export async function agentShellAvailable(): Promise<boolean> {
  if ((await loadPty()) === null) return false;
  if (platform() === "win32") return true;
  return existsSync("/bin/bash") || existsSync("/usr/bin/bash");
}

interface AgentShellTarget {
  file: string;
  args: string[];
  kind: "bash" | "powershell";
  /** Host path -> path the spawned shell understands (identity outside WSL). */
  mapPath: (p: string) => string;
  /** Host path -> working directory node-pty can spawn in (identity outside WSL). */
  spawnCwd: (p: string) => string;
}

const identity = (p: string): string => p;

/**
 * SIGKILL a dead PTY's whole process group shortly after its shell was hung up.
 *
 * `IPty.kill()` sends SIGHUP to the shell only. A command the shell had started
 * (`sleep 30`, a dev server) is orphaned still holding the pty slave open, so the
 * master never sees EOF: node-pty's handle stays active, the process leaks, and a
 * host that has disposed every shell can still refuse to exit. node-pty puts the
 * child in its own session, so the negated pid addresses that whole group.
 *
 * The timer is unref'd — it must never be the thing keeping the process alive. If
 * the loop is already clean the process exits first and there is nothing to reap;
 * if a stuck pty is holding the loop open, this is what releases it.
 */
function reapProcessGroup(pid: number | undefined): void {
  if (process.platform === "win32" || typeof pid !== "number" || pid <= 0) return;
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ESRCH: the group already exited, which is the outcome we wanted.
    }
  }, PTY_FORCE_KILL_MS);
  timer.unref?.();
}


function posixBash(): AgentShellTarget {
  // Require bash on POSIX: dash/sh has no PS0 so marker capture never starts.
  for (const file of ["/bin/bash", "/usr/bin/bash"]) {
    if (existsSync(file)) {
      return { file, args: ["--norc", "--noprofile"], kind: "bash", mapPath: identity, spawnCwd: identity };
    }
  }
  throw new ShellUnavailableError(
    "/bin/bash not found on POSIX; agent shell requires bash for PS0/PS1 marker capture",
  );
}

/**
 * Pick the executable backing the agent PTY. On Windows this follows the user's
 * configured default shell, so a WSL2 workspace gets a WSL2 agent shell instead
 * of a PowerShell one that cannot even reach the project directory.
 */
async function agentShellExecutable(shellId?: string): Promise<AgentShellTarget> {
  if (platform() !== "win32") return posixBash();

  const info = await resolveShellInfo(shellId);
  if (info.kind === "wsl") {
    return {
      file: info.path,
      // `wsl.exe -d <distro>` starts the distro's login shell, which may be zsh
      // or fish; force bash so the PS0/PS1 markers below apply.
      args: [...(info.args ?? []), "--", "bash", "--norc", "--noprofile"],
      kind: "bash",
      mapPath: toWslPath,
      spawnCwd: windowsSpawnCwd,
    };
  }

  // cmd.exe offers no prompt hook for marker capture, so anything that is not a
  // PowerShell falls back to one (preferring pwsh 7, which supports `&&`).
  const isPowerShell = /(?:pwsh|powershell)(?:\.exe)?$/i.test(info.path);
  return {
    file: isPowerShell ? info.path : (findPwsh() ?? "powershell.exe"),
    args: ["-NoLogo", "-NoProfile"],
    kind: "powershell",
    mapPath: identity,
    spawnCwd: identity,
  };
}

function stripMarkers(text: string): string {
  return text.replace(ANY_MARKER_RE, "");
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function cleanOutput(text: string): string {
  return stripAnsi(stripMarkers(text));
}

function escapeSingleQuotes(path: string): string {
  return path.replace(/'/g, `'\\''`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mirrors into deyin.log on desktop via console mirroring. */
function shellLog(level: "debug" | "warn", message: string): void {
  if (level === "debug" && process.env.DEYIN_AGENT_SHELL_DEBUG !== "1") return;
  const line = `[agent-shell] ${message}`;
  if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Persistent PTY-backed shell owned by one agent thread. Commands run serially;
 * cwd/env persist between calls. Output is streamed both to TerminalEvents (for
 * an attachable Agent tab) and to per-call onData (for live tool cards).
 */
export class AgentShell {
  readonly id: string;
  private term: IPty | null = null;
  private kind: "bash" | "powershell" = "bash";
  private readonly events: TerminalEvents;
  private readonly cols: number;
  private readonly rows: number;
  private readonly shellId: string | undefined;
  private mapPath: (p: string) => string = identity;
  private cwd: string;
  private scrollback = "";
  private queue: Promise<unknown> = Promise.resolve();
  private dataHandlers = new Set<(chunk: string) => void>();
  private exitHandlers = new Set<() => void>();
  private disposed = false;
  private ready = false;
  /** PTYs killed for intentional recycle — suppress termExit until their onExit fires. */
  private suppressExitFor = new Set<IPty>();

  constructor(opts: AgentShellOptions) {
    this.id = opts.id ?? randomUUID();
    this.cwd = opts.cwd;
    this.events = opts.events;
    this.cols = opts.cols ?? DEFAULT_COLS;
    this.rows = opts.rows ?? DEFAULT_ROWS;
    this.shellId = opts.shell;
  }

  /** Session-leader pid of the live PTY, or null when no shell is running. */
  get pid(): number | null {
    return this.term?.pid ?? null;
  }

  /** Ring-buffer of raw PTY output for late-attaching tabs. */
  getScrollback(): string {
    return this.scrollback;
  }

  write(data: string): void {
    this.term?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.term?.resize(cols, rows);
  }

  /** Serialised command execution against the persistent shell. */
  run(command: string, opts: AgentShellRunOptions): Promise<AgentShellRunResult> {
    const next = this.queue.then(() => this.runExclusive(command, opts));
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  dispose(): void {
    this.disposed = true;
    const hadTerm = this.term !== null;
    // Suppress the async node-pty onExit; we emit a single termExit below.
    this.killTerm({ suppressExit: true });
    // Wake waitForPrompt / execOnce listeners that may have missed a raced onExit.
    for (const h of [...this.exitHandlers]) {
      try {
        h();
      } catch {
        // ignore listener errors
      }
    }
    if (hadTerm) this.events.onExit(this.id, 0);
  }

  /** Ensure the PTY is up and the prompt markers are installed. */
  async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error("AgentShell has been disposed.");
    if (this.term && this.ready) return;
    await this.spawn();
  }

  private killTerm(opts?: { suppressExit?: boolean }): void {
    const t = this.term;
    this.term = null;
    this.ready = false;
    if (!t) return;
    if (opts?.suppressExit) this.suppressExitFor.add(t);
    const pid = t.pid;
    try {
      t.kill();
    } catch {
      // Keep suppressExitFor entry so a late onExit still suppresses double termExit.
    }
    reapProcessGroup(pid);
  }

  private async spawn(): Promise<void> {
    if (this.disposed) throw new Error("AgentShell has been disposed.");
    const pty = await loadPty();
    if (!pty) throw new ShellUnavailableError("Terminal support is unavailable (node-pty not built).");
    if (this.disposed) throw new Error("AgentShell has been disposed.");

    // Recycle path: suppress exit for the old PTY so the Agent tab stays alive under the same id.
    this.killTerm({ suppressExit: true });
    if (this.disposed) throw new Error("AgentShell has been disposed.");

    const target = await agentShellExecutable(this.shellId);
    if (this.disposed) throw new Error("AgentShell has been disposed.");
    this.kind = target.kind;
    this.mapPath = target.mapPath;
    const startCwd = target.spawnCwd(this.cwd);

    const term = pty.spawn(target.file, target.args, {
      name: "xterm-color",
      cols: this.cols,
      rows: this.rows,
      cwd: startCwd,
      env: { ...process.env, DEYIN_AGENT: "1", TERM: "xterm-256color" },
    });
    this.term = term;

    term.onData((data) => {
      this.appendScrollback(data);
      this.events.onData(this.id, data);
      for (const h of this.dataHandlers) h(data);
    });
    term.onExit((e) => {
      const suppress = this.suppressExitFor.delete(term);
      if (this.term === term) {
        this.term = null;
        this.ready = false;
      }
      // Skip UI exit during intentional recycle — same id keeps streaming after respawn.
      if (!suppress) {
        this.events.onExit(this.id, e.exitCode ?? 0);
      }
      for (const h of this.exitHandlers) h();
    });

    const syncStarted = Date.now();
    shellLog("debug", `spawn ${target.kind} via ${target.file} (cwd ${startCwd})`);

    // Let the shell finish its login banner before we overwrite the prompt.
    await sleep(SPAWN_BANNER_MS);
    if (this.disposed || this.term !== term) {
      if (this.term === term) this.killTerm({ suppressExit: false });
      throw new Error("AgentShell disposed during spawn");
    }

    this.writeMarkerSetup(term);

    // One readiness probe: install OSC markers, echo a unique sentinel, and
    // wait for that echo plus the following prompt marker in a single listener
    // so stale end-markers from the login banner cannot false-positive.
    const sentinel = `__DEYIN_READY_${Date.now()}__`;
    try {
      const synced = this.waitForSentinelPrompt(sentinel, SPAWN_SYNC_TIMEOUT_MS);
      if (this.kind === "powershell") {
        term.write(`Write-Output '${sentinel}'\r`);
      } else {
        term.write(`echo ${sentinel}\n`);
      }
      await synced;
      shellLog("debug", `spawn sync ok in ${Date.now() - syncStarted}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      shellLog("warn", `spawn sync failed (${message}); marking shell ready anyway`);
    }
    if (this.disposed || this.term !== term) {
      if (this.term === term) this.killTerm({ suppressExit: false });
      throw new Error("AgentShell disposed during spawn");
    }
    this.ready = true;

    // wsl.exe had to be launched from a Windows directory; move the shell to the
    // translated project path before any command runs. Also restores cwd on recycle.
    if (target.mapPath(this.cwd) !== startCwd) {
      await this.execOnce(this.cdCommand(this.cwd), READY_TIMEOUT_MS / 1000, undefined, undefined);
    }
  }

  private appendScrollback(data: string): void {
    this.scrollback += data;
    if (this.scrollback.length > SCROLLBACK_CAP) {
      this.scrollback = this.scrollback.slice(this.scrollback.length - SCROLLBACK_CAP);
    }
  }

  private writeMarkerSetup(term: IPty): void {
    if (this.kind === "powershell") {
      term.write(
        [
          "function prompt {",
          "  $code = 0; if (-not $?) { $code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 } };",
          '  Write-Host -NoNewline ("`e]6969;e;$code`a");',
          '  "deyin> "',
          "}",
          "\r",
        ].join(" "),
      );
      return;
    }
    // bash/sh: PS0 fires just before command execution; PS1 after with exit code.
    term.write(
      "PS0=$'\\033]6969;b\\007'; PS1=$'\\033]6969;e;${?}\\007deyin$ '; set +H; export PS0 PS1\n",
    );
  }

  private waitForPrompt(timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      let buf = "";
      const onData = (chunk: string) => {
        buf += chunk;
        const m = END_MARKER_RE.exec(buf);
        if (m) {
          cleanup();
          resolve(Number(m[1]));
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error("Agent shell exited while waiting for prompt"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for agent shell prompt"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.dataHandlers.delete(onData);
        this.exitHandlers.delete(onExit);
      };
      this.dataHandlers.add(onData);
      this.exitHandlers.add(onExit);
    });
  }

  /** Resolve once `needle` appears and a subsequent end-marker prompt is seen. */
  private waitForSentinelPrompt(needle: string, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      let buf = "";
      let sawNeedle = false;
      const onData = (chunk: string) => {
        buf += chunk;
        if (!sawNeedle) {
          if (!buf.includes(needle)) return;
          sawNeedle = true;
          // Keep only the tail after the needle so a prior end-marker cannot match.
          buf = buf.slice(buf.indexOf(needle) + needle.length);
        }
        const m = END_MARKER_RE.exec(buf);
        if (m) {
          cleanup();
          resolve(Number(m[1]));
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error("Agent shell exited while waiting for ready sentinel"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ready sentinel ${needle}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.dataHandlers.delete(onData);
        this.exitHandlers.delete(onExit);
      };
      this.dataHandlers.add(onData);
      this.exitHandlers.add(onExit);
    });
  }

  private async runExclusive(command: string, opts: AgentShellRunOptions): Promise<AgentShellRunResult> {
    if (this.disposed) throw new Error("AgentShell has been disposed.");
    await this.ensureStarted();

    let restarted = false;
    if (opts.cwd && opts.cwd !== this.cwd) {
      const cdResult = await this.execOnce(this.cdCommand(opts.cwd), opts.timeoutS, opts.signal, undefined);
      if (cdResult.restarted) restarted = true;
      if (cdResult.exitCode !== 0 && cdResult.exitCode !== null) {
        return {
          output: `Failed to change directory to ${opts.cwd}\n${cdResult.output}`,
          exitCode: cdResult.exitCode,
          restarted,
        };
      }
      this.cwd = opts.cwd;
    }

    const result = await this.execOnce(command, opts.timeoutS, opts.signal, opts.onData);
    return { ...result, restarted: restarted || result.restarted };
  }

  private cdCommand(cwd: string): string {
    if (this.kind === "powershell") {
      return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`;
    }
    return `cd -- '${escapeSingleQuotes(this.mapPath(cwd))}'`;
  }

  private execOnce(
    command: string,
    timeoutS: number,
    signal: AbortSignal | undefined,
    onData: ((delta: string) => void) | undefined,
  ): Promise<AgentShellRunResult> {
    return new Promise((resolve) => {
      if (!this.term) {
        resolve({ output: "(agent shell not running)", exitCode: null });
        return;
      }

      let raw = "";
      // PowerShell has no PS0 equivalent — start capturing immediately.
      let capturing = this.kind === "powershell";
      let output = "";
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let restarted = false;

      const emitClean = (chunk: string) => {
        const clean = cleanOutput(chunk);
        if (!clean) return;
        output += clean;
        onData?.(clean);
      };

      const onChunk = (chunk: string) => {
        raw += chunk;
        if (!capturing) {
          const beginAt = raw.indexOf(BEGIN_MARKER);
          if (beginAt < 0) return;
          capturing = true;
          raw = raw.slice(beginAt + BEGIN_MARKER.length);
          if (!raw) return;
        }

        const endMatch = END_MARKER_RE.exec(raw);
        if (endMatch) {
          emitClean(raw.slice(0, endMatch.index));
          finish(Number(endMatch[1]));
          return;
        }
        // Hold back a possible incomplete trailing OSC sequence.
        const incomplete = raw.lastIndexOf("\x1b]");
        if (incomplete >= 0 && incomplete > raw.length - 32) {
          emitClean(raw.slice(0, incomplete));
          raw = raw.slice(incomplete);
        } else {
          emitClean(raw);
          raw = "";
        }
      };

      const onExit = () => {
        finish(null);
      };

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        let out = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        // Drop echoed command line if it leaked in (common with some PSReadLine setups).
        out = out.replace(/\ndeyin[$>]\s*$/g, "").trimEnd();
        if (timedOut) out += `${out ? "\n" : ""}(command timed out after ${timeoutS}s and was killed)`;
        else if (cancelled) out += `${out ? "\n" : ""}(command cancelled by the user)`;
        if (restarted) out += `${out ? "\n" : ""}(shell restarted; environment reset)`;
        else if (exitCode !== null && exitCode !== 0) out += `${out ? "\n" : ""}(exit code ${exitCode})`;
        resolve({ output: out || "(no output)", exitCode, restarted });
      };

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.dataHandlers.delete(onChunk);
        this.exitHandlers.delete(onExit);
      };

      let interrupting = false;
      const interruptAndMaybeRecycle = async (reason: "timeout" | "cancel") => {
        if (settled || interrupting) return;
        interrupting = true;
        if (reason === "timeout") timedOut = true;
        else cancelled = true;

        // Detach handlers before SIGINT/recycle so kill's onExit cannot settle
        // this run early. cleanup() owns onChunk/onExit removal.
        cleanup();

        try {
          this.term?.write("\x03");
        } catch {
          // ignore
        }
        try {
          const code = await this.waitForPrompt(INTERRUPT_GRACE_MS);
          finish(code);
          return;
        } catch {
          // Shell did not recover — recycle.
        }
        restarted = true;
        if (this.disposed) {
          finish(null);
          return;
        }
        try {
          await this.spawn();
        } catch {
          // leave ready=false (includes disposed-during-spawn)
        }
        finish(null);
      };

      const onAbort = () => {
        void interruptAndMaybeRecycle("cancel");
      };

      const timer = setTimeout(() => {
        void interruptAndMaybeRecycle("timeout");
      }, timeoutS * 1000);

      this.dataHandlers.add(onChunk);
      this.exitHandlers.add(onExit);

      if (signal?.aborted) {
        void interruptAndMaybeRecycle("cancel");
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      if (this.kind === "powershell") {
        this.term.write(`Write-Host -NoNewline ("\`e]6969;b\`a"); ${command}\r`);
      } else {
        this.term.write(`${command}\n`);
      }
    });
  }
}
