import { BotError, type BotApprovalMode, type BotHarness } from "./types.js";

/**
 * Where a Bot's computer is. A Bot works in a folder of its own files and may run commands and an agent there. That
 * computer is either this machine (`local`) or a server the person owns (`server`), reached over SSH, where a small
 * engine keeps routines running while this app is closed.
 *
 * This is the port both sit behind: the types, the limits and the checks that do not depend on how the computer is
 * reached. Nothing here touches a file or a socket, so the desktop app, the engine and the settings page share it.
 */

export type BotRuntimeKind = BotHarness;

export const RUNTIME_LIMITS = Object.freeze({
  /** Longest a command may run when the caller says nothing, and the longest it may be given. */
  execTimeoutMs: 120_000,
  execTimeoutMaxMs: 600_000,
  /** Output kept from one command, per stream. More is cut and the result says so. */
  outputBytes: 256 * 1024,
  commandLength: 8_000,
  /** The largest file the runtime reads or writes in one go. */
  fileBytes: 2 * 1024 * 1024,
  listEntries: 1_000,
  pathLength: 1_024,
  promptLength: 200_000,
  /** The longest an agent run may last, and the default. */
  runTimeoutMs: 30 * 60_000,
  runTimeoutMaxMs: 2 * 60 * 60_000,
  /** Agent runs one engine does at the same time, across every Bot. */
  concurrentRuns: 2,
  /** Bots one engine keeps folders for. */
  bots: 200,
  /** Routines one Bot may keep on an engine. */
  routinesPerBot: 50,
  routineName: 80,
  cronLength: 120,
  /** Run records kept per routine. */
  runRecords: 20,
  finalText: 20_000,
});

/** What a runtime can do. A caller checks before offering the feature, instead of finding out from an error. */
export interface RuntimeCapabilities {
  /** Run a shell command in the Bot's folder. */
  exec: boolean;
  /** List, read, write and remove the Bot's files. */
  files: boolean;
  /** Run the agent as the Bot. */
  agent: boolean;
  /** Keep routines running on their own schedule while this app is closed. */
  scheduler: boolean;
  /** A browser the Bot drives on that computer. */
  browser: boolean;
}

export interface RuntimeHealth {
  ok: boolean;
  /** The engine's version, for a server. */
  version?: string;
  /** Why it is not ok, in words a person can act on. */
  reason?: string;
}

export interface RuntimeExecRequest {
  command: string;
  /** Relative to the Bot's folder. Left out, the folder itself. */
  cwd?: string;
  timeoutMs?: number;
}

export interface RuntimeExecResult {
  /** Null when the command was stopped before it exited. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Some output was cut at `RUNTIME_LIMITS.outputBytes`. */
  truncated: boolean;
}

export interface RuntimeFileEntry {
  name: string;
  /** Relative to the Bot's folder, with `/` between parts. */
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: number;
}

/**
 * How much an unattended agent may do. A person is not there to say yes, so the choice is made up front:
 * `read_only` lets it read and nothing else, `run_everything` lets it do anything its tools can.
 */
export const RUNTIME_RUN_MODES = ["read_only", "run_everything"] as const;
export type RuntimeRunMode = (typeof RUNTIME_RUN_MODES)[number];

/**
 * The run mode a Bot's approval mode becomes on a server. Auto Review needs the app's reviewer and a person to
 * ask, neither of which a server has, so it runs read-only: it can look but not change anything.
 */
export function runModeForApproval(mode: BotApprovalMode): RuntimeRunMode {
  switch (mode) {
    case "run_everything":
      return "run_everything";
    case "read_only":
    case "auto_review":
      return "read_only";
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled approval mode: ${String(unhandled)}`);
    }
  }
}

export interface RuntimeRunRequest {
  /** The whole prompt: the Bot's standing instructions, what it remembers, and the task. */
  prompt: string;
  /** `provider::model` or a model id, as the CLI takes it. */
  model: string;
  mode: RuntimeRunMode;
  maxSteps?: number;
  timeoutMs?: number;
}

export type RuntimeRunReason = "completed" | "max-steps" | "aborted" | "timeout" | "failed";

export interface RuntimeRunResult {
  reason: RuntimeRunReason;
  finalText: string;
  /** What went wrong, when `reason` is `failed`. */
  error?: string;
}

/** A routine as the engine keeps it: what to run and when. The desktop's own routine record stays the source of truth. */
export interface EngineRoutine {
  id: string;
  name: string;
  /** A cron expression in the engine's time zone. */
  cron: string;
  prompt: string;
  model: string;
  mode: RuntimeRunMode;
  enabled: boolean;
  timeoutMs?: number;
}

export type EngineRunStatus = "running" | "completed" | "failed" | "aborted" | "timeout" | "skipped";

export interface EngineRunRecord {
  id: string;
  routineId: string;
  startedAt: number;
  finishedAt?: number;
  status: EngineRunStatus;
  /** How it was started. */
  trigger: "schedule" | "manual";
  /** Why a run did not complete, or what the Bot reported. */
  reason?: string;
  finalText?: string;
}

export interface EngineRoutineView extends EngineRoutine {
  /** Unix ms of the next scheduled run, or undefined when paused or finished. */
  nextRunAt?: number;
  lastRun?: EngineRunRecord;
}

/** What the Servers page shows for one server's engine. */
export interface EngineStatus {
  apiVersion: number;
  version: string;
  /** Unix ms the engine process started. */
  startedAt: number;
  /** Whether the `deyin` agent the engine runs is on the server, and signed in there. */
  agent: { found: boolean; version?: string; signedIn: boolean };
  bots: Array<{ botId: string; routines: number; running: number }>;
  runningNow: number;
}

/** What a runtime can do, by kind. A server cannot yet drive a browser: that stays on the desktop. */
export function runtimeCapabilities(kind: BotRuntimeKind): RuntimeCapabilities {
  switch (kind) {
    case "local":
      return { exec: true, files: true, agent: true, scheduler: false, browser: true };
    case "server":
      return { exec: true, files: true, agent: true, scheduler: true, browser: false };
    default: {
      const unhandled: never = kind;
      throw new Error(`Unhandled runtime kind: ${String(unhandled)}`);
    }
  }
}

/** The port. One implementation for this machine, one for a server; the rest of the app does not care which. */
export interface BotRuntime {
  readonly kind: BotRuntimeKind;
  readonly capabilities: RuntimeCapabilities;
  /** Where the Bot's files are, for showing a person. */
  readonly home: string;
  health(signal?: AbortSignal): Promise<RuntimeHealth>;
  exec(request: RuntimeExecRequest, signal?: AbortSignal): Promise<RuntimeExecResult>;
  listFiles(path: string, signal?: AbortSignal): Promise<RuntimeFileEntry[]>;
  readFile(path: string, signal?: AbortSignal): Promise<string>;
  writeFile(path: string, content: string, signal?: AbortSignal): Promise<void>;
  removeFile(path: string, options?: { recursive?: boolean }, signal?: AbortSignal): Promise<void>;
  /** Run the agent as the Bot. `onEvent` gets each line the agent prints, as the CLI's JSON. */
  run(request: RuntimeRunRequest, onEvent: (line: string) => void, signal?: AbortSignal): Promise<RuntimeRunResult>;
}

/* Checks ---------------------------------------------------------------------- */

const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidRuntimeBotId(value: unknown): value is string {
  return typeof value === "string" && BOT_ID.test(value);
}

const ROUTINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidRoutineId(value: unknown): value is string {
  return typeof value === "string" && ROUTINE_ID.test(value);
}

function invalid(message: string): never {
  throw new BotError("invalid", message);
}

/**
 * A path inside a Bot's folder, as the part after the folder: no leading `/`, no `..`, no drive letter, no backslash,
 * no control character. `.` and empty parts are dropped. "" is the folder itself, which only a listing may name
 * (`allowRoot`). The same check runs on the desktop and on the engine, and the engine checks again against the
 * real folder, so a symbolic link cannot lead out of it either.
 */
export function cleanRelativePath(value: unknown, options: { allowRoot?: boolean } = {}): string {
  if (typeof value !== "string") return invalid("A path must be text.");
  if (value.length > RUNTIME_LIMITS.pathLength) return invalid("That path is too long.");
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return invalid("That path has a character a path cannot have.");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return invalid("A path must be inside the Bot's folder, not absolute.");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return invalid("A path cannot go up out of the Bot's folder.");
    parts.push(part);
  }
  if (parts.length === 0 && options.allowRoot !== true) return invalid("Name a file or folder.");
  return parts.join("/");
}

function whole(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return invalid(`${what} must be a whole number.`);
  if (value < min || value > max) return invalid(`${what} must be between ${min} and ${max}.`);
  return value;
}

function optionalTimeout(value: unknown, what: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  return whole(value, what, 1_000, max);
}

export function isRunMode(value: unknown): value is RuntimeRunMode {
  return typeof value === "string" && (RUNTIME_RUN_MODES as readonly string[]).includes(value);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") return invalid(`${what} must be text.`);
  if (value.trim() === "") return invalid(`${what} is required.`);
  if (value.length > max) return invalid(`${what} is too long (at most ${max} characters).`);
  return value;
}

/** A command to run: what the engine takes from the desktop, checked again here because it is untrusted input. */
export function parseExecRequest(input: unknown): RuntimeExecRequest {
  const source = record(input, "The command request");
  const command = text(source.command, "The command", RUNTIME_LIMITS.commandLength);
  if (command.includes("\u0000")) return invalid("The command has a character a command cannot have.");
  const cwd = source.cwd === undefined || source.cwd === null ? undefined : cleanRelativePath(source.cwd, { allowRoot: true });
  const timeoutMs = optionalTimeout(source.timeoutMs, "The timeout", RUNTIME_LIMITS.execTimeoutMaxMs);
  return { command, ...(cwd ? { cwd } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

/** An agent run to start. */
export function parseRunRequest(input: unknown): RuntimeRunRequest {
  const source = record(input, "The run request");
  const prompt = text(source.prompt, "The prompt", RUNTIME_LIMITS.promptLength);
  const model = text(source.model, "The model", 200);
  if (/\s/.test(model)) return invalid("The model cannot contain spaces.");
  if (!isRunMode(source.mode)) return invalid("The mode must be read_only or run_everything.");
  const maxSteps = source.maxSteps === undefined || source.maxSteps === null ? undefined : whole(source.maxSteps, "The step limit", 1, 1_000);
  const timeoutMs = optionalTimeout(source.timeoutMs, "The timeout", RUNTIME_LIMITS.runTimeoutMaxMs);
  return { prompt, model, mode: source.mode, ...(maxSteps !== undefined ? { maxSteps } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

/**
 * A routine to keep. The cron expression is checked for shape here; the engine checks that it parses and that the
 * runs are not closer together than a routine may be, because that needs the cron library.
 */
export function parseEngineRoutine(input: unknown, routineId: string): EngineRoutine {
  const source = record(input, "The routine");
  if (!isValidRoutineId(routineId)) return invalid("That is not a routine id.");
  const name = text(source.name, "The name", RUNTIME_LIMITS.routineName).trim();
  const cron = text(source.cron, "The schedule", RUNTIME_LIMITS.cronLength).trim();
  if (/[\u0000-\u001f\u007f]/.test(cron)) return invalid("The schedule has a character a schedule cannot have.");
  const prompt = text(source.prompt, "The instruction", RUNTIME_LIMITS.promptLength);
  const model = text(source.model, "The model", 200);
  if (/\s/.test(model)) return invalid("The model cannot contain spaces.");
  if (!isRunMode(source.mode)) return invalid("The mode must be read_only or run_everything.");
  if (typeof source.enabled !== "boolean") return invalid("Say whether the routine is on.");
  const timeoutMs = optionalTimeout(source.timeoutMs, "The timeout", RUNTIME_LIMITS.runTimeoutMaxMs);
  return { id: routineId, name, cron, prompt, model, mode: source.mode, enabled: source.enabled, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

/** The timeout a command runs under. */
export function execTimeout(request: Pick<RuntimeExecRequest, "timeoutMs">): number {
  return Math.min(request.timeoutMs ?? RUNTIME_LIMITS.execTimeoutMs, RUNTIME_LIMITS.execTimeoutMaxMs);
}

/** The timeout an agent run runs under. */
export function runTimeout(request: Pick<RuntimeRunRequest, "timeoutMs">): number {
  return Math.min(request.timeoutMs ?? RUNTIME_LIMITS.runTimeoutMs, RUNTIME_LIMITS.runTimeoutMaxMs);
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** Keep the front of `value`, up to `maxBytes` of it, and say whether anything was cut. Never cuts a character in half. */
export function clipOutput(value: string, maxBytes: number = RUNTIME_LIMITS.outputBytes): { text: string; truncated: boolean } {
  if (byteLength(value) <= maxBytes) return { text: value, truncated: false };
  // Bytes are at least characters, so the cut is at or before `maxBytes` characters; walk back until it fits.
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  // A cut between the two halves of a surrogate pair leaves a lone half, which would not survive being sent.
  if (end > 0) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return { text: value.slice(0, end), truncated: true };
}
