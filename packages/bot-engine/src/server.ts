import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  BotError,
  ENGINE_API_VERSION,
  engineErrorStatus,
  isValidRoutineId,
  isValidRuntimeBotId,
  parseExecRequest,
  parseRunEnd,
  parseRunRequest,
  type EngineErrorBody,
  type EngineHealth,
} from "@deyin/host-core";
import type { BotEngine } from "./engine.js";

/** Large enough for a 2 MB file once it is JSON-escaped, small enough that no one request ties up the server. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Whether `header` is `Bearer <token>`, compared without leaking how much of it matched. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (header === undefined || !header.startsWith(prefix)) return false;
  return timingSafeEqual(digest(header.slice(prefix.length)), digest(token));
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

function sendError(res: ServerResponse, code: EngineErrorBody["code"], message: string): void {
  sendJson(res, engineErrorStatus(code), { error: message, code } satisfies EngineErrorBody);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += part.byteLength;
    if (size > MAX_BODY_BYTES) throw new BotError("limit", "That request is too large.");
    chunks.push(part);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BotError("invalid", "The request was not valid JSON.");
  }
}

function sendFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    // Part of an answer has gone out; the only honest thing left is to cut the connection.
    res.destroy();
    return;
  }
  if (error instanceof BotError) {
    const code: EngineErrorBody["code"] = error.code;
    sendError(res, code, error.message);
    return;
  }
  console.error(`deyin bot-engine: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  sendError(res, "internal", "The engine hit an unexpected error.");
}

/** An answer made of lines, sent as they are produced. The headers go out with the first one. */
class LineStream {
  private started = false;
  constructor(private readonly res: ServerResponse) {}

  write(line: string): void {
    if (this.res.writableEnded || this.res.destroyed) return;
    if (!this.started) {
      this.res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
      this.started = true;
    }
    this.res.write(`${line}\n`);
  }

  end(): void {
    if (!this.res.writableEnded) this.res.end();
  }
}

/** A controller that aborts when the caller goes away before the answer is finished. */
function abortOnClose(res: ServerResponse): AbortController {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller;
}

export interface EngineServerOptions {
  engine: BotEngine;
  /** The key a caller must show on every call but `/health`. */
  token: string;
  version: string;
}

const MIN_TOKEN_LENGTH = 32;

/**
 * The engine's HTTP face. It is built to be reached through an SSH forward to the server's own loopback: it checks
 * the token on every call that does anything, and never lets a path or an id it was given choose where it reads.
 */
export function createEngineServer(options: EngineServerOptions): Server {
  const { engine, token, version } = options;
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`The engine's token must be at least ${MIN_TOKEN_LENGTH} characters.`);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://engine.local");
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, apiVersion: ENGINE_API_VERSION, version } satisfies EngineHealth);
      return;
    }
    if (!bearerMatches(req.headers.authorization, token)) {
      sendError(res, "unauthorized", "unauthorized");
      return;
    }
    if (method === "GET" && path === "/v1/status") {
      sendJson(res, 200, await engine.status());
      return;
    }

    const bot = /^\/v1\/bots\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (!bot) return sendError(res, "not_found", "No such route.");
    let botId: string;
    try {
      botId = decodeURIComponent(bot[1]!);
    } catch {
      return sendError(res, "invalid", "That is not a Bot id.");
    }
    if (!isValidRuntimeBotId(botId)) return sendError(res, "invalid", "That is not a Bot id.");
    const rest = bot[2] ?? "";
    const filePath = url.searchParams.get("path") ?? "";

    if (rest === "") {
      if (method !== "DELETE") return sendError(res, "not_found", "No such route.");
      sendJson(res, 200, { removed: engine.removeBot(botId) });
      return;
    }

    if (rest === "exec" && method === "POST") {
      const request = parseExecRequest(await readBody(req));
      const controller = abortOnClose(res);
      const stream = new LineStream(res);
      await engine.exec(botId, request, (line) => stream.write(JSON.stringify(line)), controller.signal);
      stream.end();
      return;
    }

    if (rest === "run" && method === "POST") {
      const request = parseRunRequest(await readBody(req));
      const controller = abortOnClose(res);
      const stream = new LineStream(res);
      const end = await engine.runChat(
        botId,
        request,
        (line) => {
          // Only the engine says how a run ended. A line that claims to is the agent talking, and is not passed on.
          if (parseRunEnd(line) === null) stream.write(line);
        },
        controller.signal,
      );
      stream.write(JSON.stringify(end));
      stream.end();
      return;
    }

    if (rest === "files/list" && method === "GET") {
      sendJson(res, 200, { entries: await engine.listFiles(botId, filePath) });
      return;
    }
    if (rest === "files/content" && method === "GET") {
      sendJson(res, 200, { content: await engine.readFile(botId, filePath) });
      return;
    }
    if (rest === "files/content" && method === "PUT") {
      const body = await readBody(req);
      const content = typeof body === "object" && body !== null ? (body as { content?: unknown }).content : undefined;
      if (typeof content !== "string") throw new BotError("invalid", "A file's content must be text.");
      await engine.writeFile(botId, filePath, content);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (rest === "files" && method === "DELETE") {
      await engine.removeFile(botId, filePath, url.searchParams.get("recursive") === "1");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (rest === "routines" && method === "GET") {
      sendJson(res, 200, { routines: engine.routineViews(botId) });
      return;
    }
    const routine = /^routines\/([^/]+)(?:\/(run|runs))?$/.exec(rest);
    if (routine) {
      let routineId: string;
      try {
        routineId = decodeURIComponent(routine[1]!);
      } catch {
        return sendError(res, "invalid", "That is not a routine id.");
      }
      if (!isValidRoutineId(routineId)) return sendError(res, "invalid", "That is not a routine id.");
      const action = routine[2];
      if (action === undefined && method === "PUT") {
        sendJson(res, 200, { routine: engine.saveRoutine(botId, routineId, await readBody(req)) });
        return;
      }
      if (action === undefined && method === "DELETE") {
        sendJson(res, 200, { removed: engine.removeRoutine(botId, routineId) });
        return;
      }
      if (action === "run" && method === "POST") {
        sendJson(res, 202, { run: await engine.runRoutineNow(botId, routineId) });
        return;
      }
      if (action === "runs" && method === "GET") {
        sendJson(res, 200, { runs: engine.routineRuns(botId, routineId) });
        return;
      }
    }
    sendError(res, "not_found", "No such route.");
  }

  return createServer((req, res) => {
    route(req, res).catch((error: unknown) => sendFailure(res, error));
  });
}
