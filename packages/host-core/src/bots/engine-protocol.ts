import { BotError } from "./types.js";
import type { EngineRunRecord, EngineRunStatus, RuntimeExecResult, RuntimeRunReason } from "./runtime.js";

/**
 * How the desktop talks to a Bot engine on a server: the paths, the lines a streamed answer is made of, and a reader
 * that puts lines back together from chunks. Pure, so the engine and the desktop agree by construction.
 *
 * The engine listens on the server's own loopback only. The desktop reaches it through an SSH port forward, so no
 * port is opened to anyone else, and every call carries the engine's token as well.
 */

export const ENGINE_API_VERSION = 1;
export const ENGINE_DEFAULT_PORT = 7790;
/** The engine's folder in the server user's home. */
export const ENGINE_HOME = ".deyin-bot";

export const ENGINE_PATHS = Object.freeze({
  health: "/health",
  status: "/v1/status",
  bot: (botId: string): string => `/v1/bots/${encodeURIComponent(botId)}`,
  exec: (botId: string): string => `/v1/bots/${encodeURIComponent(botId)}/exec`,
  run: (botId: string): string => `/v1/bots/${encodeURIComponent(botId)}/run`,
  files: (botId: string): string => `/v1/bots/${encodeURIComponent(botId)}/files`,
  fileList: (botId: string): string => `/v1/bots/${encodeURIComponent(botId)}/files/list`,
  fileContent: (botId: string): string => `/v1/bots/${encodeURIComponent(botId)}/files/content`,
  routines: (botId: string): string => `/v1/bots/${encodeURIComponent(botId)}/routines`,
  routine: (botId: string, routineId: string): string => `/v1/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}`,
  routineRun: (botId: string, routineId: string): string => `/v1/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}/run`,
  routineRuns: (botId: string, routineId: string): string => `/v1/bots/${encodeURIComponent(botId)}/routines/${encodeURIComponent(routineId)}/runs`,
});

/** `/health` answers without the token, so an installer can tell an engine from something else on the port. */
export interface EngineHealth {
  ok: true;
  apiVersion: number;
  version: string;
}

export function isEngineHealth(value: unknown): value is EngineHealth {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.ok === true && typeof v.apiVersion === "number" && typeof v.version === "string";
}

/** One line of an answer to `exec`. */
export type EngineExecLine =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number | null; timedOut: boolean };

/**
 * The last line of an answer to `run`: how the agent process ended. Every line before it is what the agent printed,
 * untouched, so the desktop reads it with the parser it already has for `deyin run --json`.
 */
export interface EngineRunEnd {
  type: "engine-exit";
  code: number | null;
  timedOut: boolean;
  /** The caller went away or asked to stop, and the process was killed. */
  aborted: boolean;
  /** Why the process could not start or was killed, when there is more to say than the code. */
  error?: string;
  /** The end of what the agent wrote to stderr, sent when it failed, so the person is told why. */
  stderr?: string;
}

export interface EngineErrorBody {
  error: string;
  code: "unauthorized" | "invalid" | "not_found" | "conflict" | "limit" | "internal";
}

/** The HTTP status that goes with an error code. */
export function engineErrorStatus(code: EngineErrorBody["code"]): number {
  switch (code) {
    case "unauthorized":
      return 401;
    case "invalid":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "limit":
      return 429;
    case "internal":
      return 500;
    default: {
      const unhandled: never = code;
      throw new Error(`Unhandled error code: ${String(unhandled)}`);
    }
  }
}

/** Turn an error answer back into the refusal a person reads. A code the desktop does not know is a conflict. */
export function engineErrorFrom(status: number, body: unknown): BotError {
  const parsed = typeof body === "object" && body !== null ? (body as Partial<EngineErrorBody>) : {};
  const message = typeof parsed.error === "string" && parsed.error ? parsed.error : `The engine answered with status ${status}.`;
  if (status === 401) return new BotError("conflict", "The engine did not accept the desktop's key. Reinstall the engine on this server.");
  switch (parsed.code) {
    case "invalid":
      return new BotError("invalid", message);
    case "not_found":
      return new BotError("not_found", message);
    case "limit":
      return new BotError("limit", message);
    default:
      return new BotError("conflict", message);
  }
}

/** Put the lines of a streamed answer back together from chunks that may split one anywhere. */
export class LineSplitter {
  private pending = "";

  /** Feed a chunk; get the complete lines it finished, without their newlines and without blank ones. */
  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    return parts.map((line) => line.replace(/\r$/, "")).filter((line) => line !== "");
  }

  /** The unfinished last line, if the stream ended without a newline. */
  end(): string[] {
    const rest = this.pending.replace(/\r$/, "");
    this.pending = "";
    return rest === "" ? [] : [rest];
  }
}

function isExecLine(value: unknown): value is EngineExecLine {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === "stdout" || v.type === "stderr") return typeof v.data === "string";
  return v.type === "exit" && (v.code === null || typeof v.code === "number") && typeof v.timedOut === "boolean";
}

/** Parse one line of an `exec` answer, or null when it is not one. */
export function parseExecLine(line: string): EngineExecLine | null {
  try {
    const value: unknown = JSON.parse(line);
    return isExecLine(value) ? value : null;
  } catch {
    return null;
  }
}

/** Parse the last line of a `run` answer, or null when the line is something the agent printed. */
export function parseRunEnd(line: string): EngineRunEnd | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value?.type !== "engine-exit") return null;
    if (!(value.code === null || typeof value.code === "number")) return null;
    return {
      type: "engine-exit",
      code: value.code,
      timedOut: value.timedOut === true,
      aborted: value.aborted === true,
      ...(typeof value.error === "string" ? { error: value.error } : {}),
      ...(typeof value.stderr === "string" ? { stderr: value.stderr } : {}),
    };
  } catch {
    return null;
  }
}

/** Fold the lines of an `exec` answer into a result, keeping at most `maxBytes` of each stream. */
export class ExecCollector {
  private stdout = "";
  private stderr = "";
  private truncated = false;
  private result: { code: number | null; timedOut: boolean } | null = null;

  constructor(private readonly maxBytes: number) {}

  add(line: EngineExecLine): void {
    if (line.type === "exit") {
      this.result = { code: line.code, timedOut: line.timedOut };
      return;
    }
    const key = line.type;
    const room = this.maxBytes - new TextEncoder().encode(this[key]).length;
    if (new TextEncoder().encode(line.data).length <= room) {
      this[key] += line.data;
      return;
    }
    // Keep the front that fits, cut on a whole character.
    let end = Math.min(line.data.length, room);
    while (end > 0 && new TextEncoder().encode(line.data.slice(0, end)).length > room) end -= 1;
    this[key] += line.data.slice(0, end);
    this.truncated = true;
  }

  /** What has come in so far, for a command that was stopped before it said how it ended. */
  partial(): RuntimeExecResult {
    return { code: null, timedOut: false, stdout: this.stdout, stderr: this.stderr, truncated: this.truncated };
  }

  /** Null until the engine said how the command ended. */
  finish(): RuntimeExecResult | null {
    if (!this.result) return null;
    return { code: this.result.code, timedOut: this.result.timedOut, stdout: this.stdout, stderr: this.stderr, truncated: this.truncated };
  }
}

const RUN_STATUSES: readonly EngineRunStatus[] = ["running", "completed", "failed", "aborted", "timeout", "skipped"];

/** Check a run record the engine sent, so a mismatched engine shows as an error and not as a broken page. */
export function isEngineRunRecord(value: unknown): value is EngineRunRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.routineId === "string" &&
    typeof v.startedAt === "number" &&
    typeof v.status === "string" &&
    (RUN_STATUSES as readonly string[]).includes(v.status) &&
    (v.trigger === "schedule" || v.trigger === "manual")
  );
}

/** What the agent's own `result` line said, or undefined for any other line. */
export function parseAgentResultLine(line: string): { finalText: string; reason: string } | undefined {
  try {
    const value = JSON.parse(line) as { type?: unknown; finalText?: unknown; reason?: unknown } | null;
    if (value?.type !== "result") return undefined;
    return { finalText: typeof value.finalText === "string" ? value.finalText : "", reason: typeof value.reason === "string" ? value.reason : "" };
  } catch {
    return undefined;
  }
}

/** How a run ended, from how the process ended and what the agent said last (its `result` reason, if it said any). */
export function runReasonFrom(end: Pick<EngineRunEnd, "timedOut" | "aborted" | "error">, resultReason: string): RuntimeRunReason {
  if (end.error) return "failed";
  if (end.timedOut) return "timeout";
  if (end.aborted) return "aborted";
  if (resultReason === "completed" || resultReason === "max-steps" || resultReason === "aborted") return resultReason;
  return "failed";
}

/** Why a run did not complete, in words for the person who has to act on it. */
export function runFailureMessage(end: Pick<EngineRunEnd, "code" | "timedOut" | "aborted" | "error" | "stderr">): string {
  if (end.error) return end.error;
  if (end.timedOut) return "The run took longer than its time limit and was stopped.";
  if (end.aborted) return "The run was stopped.";
  if (end.code === 2) return "The agent on this server is not signed in. Sign in again from the Servers page.";
  const detail = end.stderr ? ` ${end.stderr.trim().slice(0, 400)}` : "";
  return `The agent stopped with exit code ${end.code ?? "unknown"}.${detail}`;
}
