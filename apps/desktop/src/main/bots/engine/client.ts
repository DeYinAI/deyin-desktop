import { request as httpRequest, type Agent, type IncomingMessage } from "node:http";
import {
  BotError,
  ENGINE_PATHS,
  ExecCollector,
  LineSplitter,
  RUNTIME_LIMITS,
  engineErrorFrom,
  isEngineHealth,
  isEngineRunRecord,
  parseAgentResultLine,
  parseExecLine,
  parseRunEnd,
  runFailureMessage,
  runReasonFrom,
  type EngineHealth,
  type EngineRoutine,
  type EngineRoutineView,
  type EngineRunEnd,
  type EngineRunRecord,
  type EngineStatus,
  type RuntimeExecRequest,
  type RuntimeExecResult,
  type RuntimeFileEntry,
  type RuntimeRunRequest,
  type RuntimeRunResult,
} from "@deyin/host-core";

/**
 * Where an engine is and how to reach it. In use `agent` is an SSH forward to the server's own loopback; a test
 * leaves it out and reaches an engine on this machine directly. Either way the engine sees the same HTTP.
 */
export interface EngineEndpoint {
  host: string;
  port: number;
  /** The key the engine asks for. */
  token: string;
  agent?: Agent;
  /** What the server is called, for the messages a person reads. */
  label: string;
  /** How long an ordinary call may take; 30 seconds by default. */
  callTimeoutMs?: number;
}

/** How long an ordinary call may take. Streamed answers (a command, an agent run) have their own limits. */
const CALL_TIMEOUT_MS = 30_000;

/** What `run` hands back beyond the result: how the process ended, for a caller that wants the exit code. */
export interface EngineRunOutcome extends RuntimeRunResult {
  end: EngineRunEnd;
}

function unreachable(label: string, error: unknown): BotError {
  const detail = error instanceof Error ? error.message : String(error);
  return new BotError("conflict", `Could not reach the Bot engine on ${label}: ${detail}`);
}

async function* readLines(res: IncomingMessage): AsyncGenerator<string> {
  const splitter = new LineSplitter();
  res.setEncoding("utf8");
  for await (const chunk of res) yield* splitter.push(chunk as string);
  yield* splitter.end();
}

async function readText(res: IncomingMessage): Promise<string> {
  res.setEncoding("utf8");
  let text = "";
  for await (const chunk of res) text += chunk as string;
  return text;
}

/**
 * The desktop's side of the engine protocol. Everything that crosses the wire is checked on the way back in, so an
 * engine that is a different version, or is not an engine at all, shows up as a clear refusal and not a broken page.
 */
export class EngineClient {
  constructor(private readonly endpoint: EngineEndpoint) {}

  /** `/health`, which asks for no key: whether something that answers like an engine is there. */
  async health(signal?: AbortSignal): Promise<EngineHealth> {
    const { status, text } = await this.call("GET", ENGINE_PATHS.health, undefined, signal, false);
    const parsed = tryParse(text);
    if (status !== 200 || !isEngineHealth(parsed)) throw new BotError("conflict", `Something answered on ${this.endpoint.label}, but it is not a Bot engine.`);
    return parsed;
  }

  async status(signal?: AbortSignal): Promise<EngineStatus> {
    return (await this.json("GET", ENGINE_PATHS.status, undefined, signal)) as EngineStatus;
  }

  async listFiles(botId: string, path: string, signal?: AbortSignal): Promise<RuntimeFileEntry[]> {
    const body = (await this.json("GET", `${ENGINE_PATHS.fileList(botId)}?path=${encodeURIComponent(path)}`, undefined, signal)) as { entries?: unknown };
    if (!Array.isArray(body.entries)) throw new BotError("conflict", "The engine sent a file list this app does not understand.");
    return body.entries as RuntimeFileEntry[];
  }

  async readFile(botId: string, path: string, signal?: AbortSignal): Promise<string> {
    const body = (await this.json("GET", `${ENGINE_PATHS.fileContent(botId)}?path=${encodeURIComponent(path)}`, undefined, signal)) as { content?: unknown };
    if (typeof body.content !== "string") throw new BotError("conflict", "The engine sent a file this app does not understand.");
    return body.content;
  }

  async writeFile(botId: string, path: string, content: string, signal?: AbortSignal): Promise<void> {
    await this.json("PUT", `${ENGINE_PATHS.fileContent(botId)}?path=${encodeURIComponent(path)}`, { content }, signal);
  }

  async removeFile(botId: string, path: string, recursive: boolean, signal?: AbortSignal): Promise<void> {
    await this.json("DELETE", `${ENGINE_PATHS.files(botId)}?path=${encodeURIComponent(path)}${recursive ? "&recursive=1" : ""}`, undefined, signal);
  }

  /** Forget a Bot on the server: its files, routines and run records. */
  async removeBot(botId: string, signal?: AbortSignal): Promise<boolean> {
    return ((await this.json("DELETE", ENGINE_PATHS.bot(botId), undefined, signal)) as { removed?: unknown }).removed === true;
  }

  /**
   * Run a command in the Bot's folder on the server. Stopping early (`signal`) stops the command there and gives back
   * what it had printed, with no exit code.
   */
  async exec(botId: string, request: RuntimeExecRequest, signal?: AbortSignal): Promise<RuntimeExecResult> {
    const collector = new ExecCollector(RUNTIME_LIMITS.outputBytes);
    let res: IncomingMessage;
    try {
      res = await this.open("POST", ENGINE_PATHS.exec(botId), request, signal);
    } catch (error) {
      // Stopped before the engine had anything to say (it answers once the command has output): nothing ran to completion.
      if (signal?.aborted) return collector.partial();
      throw error;
    }
    if (res.statusCode !== 200) throw await this.refusal(res);
    try {
      for await (const line of readLines(res)) {
        const parsed = parseExecLine(line);
        if (parsed) collector.add(parsed);
      }
    } catch (error) {
      if (signal?.aborted) return collector.partial();
      throw unreachable(this.endpoint.label, error);
    }
    const result = collector.finish();
    if (result) return result;
    if (signal?.aborted) return collector.partial();
    throw new BotError("conflict", `The connection to ${this.endpoint.label} dropped before the command finished.`);
  }

  /**
   * Run the agent as the Bot on the server. `onLine` gets each line the agent printed, as `deyin run --json` printed it.
   * Stopping early (`signal`) stops the agent there.
   */
  async run(botId: string, request: RuntimeRunRequest, onLine: (line: string) => void, signal?: AbortSignal): Promise<EngineRunOutcome> {
    let res: IncomingMessage;
    try {
      res = await this.open("POST", ENGINE_PATHS.run(botId), request, signal);
    } catch (error) {
      // Stopped before the engine had anything to say (it answers once the agent has printed something).
      if (signal?.aborted) return { reason: "aborted", finalText: "", end: { type: "engine-exit", code: null, timedOut: false, aborted: true } };
      throw error;
    }
    if (res.statusCode !== 200) throw await this.refusal(res);
    let end: EngineRunEnd | null = null;
    let finalText = "";
    let resultReason = "";
    try {
      for await (const line of readLines(res)) {
        const ended = parseRunEnd(line);
        if (ended) {
          end = ended;
          continue;
        }
        const result = parseAgentResultLine(line);
        if (result) {
          finalText = result.finalText;
          resultReason = result.reason;
        }
        onLine(line);
      }
    } catch (error) {
      if (!signal?.aborted) throw unreachable(this.endpoint.label, error);
    }
    if (!end) {
      // The connection ended without the engine saying how the run did: stopped on purpose, or cut.
      if (signal?.aborted) return { reason: "aborted", finalText, end: { type: "engine-exit", code: null, timedOut: false, aborted: true } };
      throw new BotError("conflict", `The connection to ${this.endpoint.label} dropped before the Bot finished.`);
    }
    const reason = runReasonFrom(end, resultReason);
    return {
      reason,
      finalText,
      end,
      ...(reason === "failed" ? { error: runFailureMessage(end) } : {}),
    };
  }

  /* Routines -------------------------------------------------------------------- */

  async routines(botId: string, signal?: AbortSignal): Promise<EngineRoutineView[]> {
    const body = (await this.json("GET", ENGINE_PATHS.routines(botId), undefined, signal)) as { routines?: unknown };
    if (!Array.isArray(body.routines)) throw new BotError("conflict", "The engine sent routines this app does not understand.");
    return body.routines as EngineRoutineView[];
  }

  /** Keep a routine on the server. The engine checks the schedule and says no to one it will not run. */
  async saveRoutine(botId: string, routine: EngineRoutine, signal?: AbortSignal): Promise<EngineRoutineView> {
    const { id, ...rest } = routine;
    const body = (await this.json("PUT", ENGINE_PATHS.routine(botId, id), rest, signal)) as { routine?: unknown };
    if (typeof body.routine !== "object" || body.routine === null) throw new BotError("conflict", "The engine did not confirm the routine.");
    return body.routine as EngineRoutineView;
  }

  async removeRoutine(botId: string, routineId: string, signal?: AbortSignal): Promise<boolean> {
    return ((await this.json("DELETE", ENGINE_PATHS.routine(botId, routineId), undefined, signal)) as { removed?: unknown }).removed === true;
  }

  /** Start a routine now. Answers once it has started; its record says how it goes. */
  async runRoutineNow(botId: string, routineId: string, signal?: AbortSignal): Promise<EngineRunRecord> {
    const body = (await this.json("POST", ENGINE_PATHS.routineRun(botId, routineId), undefined, signal)) as { run?: unknown };
    if (!isEngineRunRecord(body.run)) throw new BotError("conflict", "The engine sent a run this app does not understand.");
    return body.run;
  }

  async routineRuns(botId: string, routineId: string, signal?: AbortSignal): Promise<EngineRunRecord[]> {
    const body = (await this.json("GET", ENGINE_PATHS.routineRuns(botId, routineId), undefined, signal)) as { runs?: unknown };
    if (!Array.isArray(body.runs)) throw new BotError("conflict", "The engine sent runs this app does not understand.");
    return body.runs.filter(isEngineRunRecord);
  }

  /* Wire ------------------------------------------------------------------------ */

  /** Open a call and hand back the answer as it starts, for the streamed ones. */
  private open(method: string, path: string, body: unknown, signal: AbortSignal | undefined, authed = true): Promise<IncomingMessage> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new BotError("conflict", "Stopped."));
        return;
      }
      const req = httpRequest(
        {
          host: this.endpoint.host,
          port: this.endpoint.port,
          method,
          path,
          ...(this.endpoint.agent ? { agent: this.endpoint.agent } : {}),
          headers: {
            ...(authed ? { authorization: `Bearer ${this.endpoint.token}` } : {}),
            ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          },
        },
        resolve,
      );
      const onAbort = (): void => {
        req.destroy();
        reject(new BotError("conflict", "Stopped."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (error) => reject(signal?.aborted ? new BotError("conflict", "Stopped.") : unreachable(this.endpoint.label, error)));
      req.on("close", () => signal?.removeEventListener("abort", onAbort));
      req.end(payload);
    });
  }

  private async call(method: string, path: string, body: unknown, signal: AbortSignal | undefined, authed = true): Promise<{ status: number; text: string }> {
    const limit = AbortSignal.timeout(this.endpoint.callTimeoutMs ?? CALL_TIMEOUT_MS);
    const both = signal ? AbortSignal.any([signal, limit]) : limit;
    let res: IncomingMessage;
    try {
      res = await this.open(method, path, body, both, authed);
    } catch (error) {
      if (limit.aborted && !signal?.aborted) throw new BotError("conflict", `${this.endpoint.label} did not answer in time.`);
      throw error;
    }
    try {
      return { status: res.statusCode ?? 0, text: await readText(res) };
    } catch (error) {
      if (limit.aborted && !signal?.aborted) throw new BotError("conflict", `${this.endpoint.label} did not answer in time.`);
      throw unreachable(this.endpoint.label, error);
    }
  }

  private async json(method: string, path: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    const { status, text } = await this.call(method, path, body, signal);
    const parsed = tryParse(text);
    if (status < 200 || status >= 300) throw engineErrorFrom(status, parsed);
    if (parsed === undefined) throw new BotError("conflict", `${this.endpoint.label} sent an answer this app does not understand.`);
    return parsed;
  }

  /** The refusal in an error answer, once the call has already been opened. */
  private async refusal(res: IncomingMessage): Promise<BotError> {
    return engineErrorFrom(res.statusCode ?? 0, tryParse(await readText(res)));
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
