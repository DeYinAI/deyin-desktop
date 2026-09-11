import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadCliCapabilities } from "./capabilities.js";
import type { CliContext } from "./context.js";
import { runHeadless } from "./headless.js";
import { VERSION } from "./version.js";
import { listModels } from "@deyin/host-core";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface CliServerOptions {
  hostname?: string;
  port?: number;
  authToken?: string;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += part.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(part);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function capture(): { stream: NodeJS.WritableStream; read: () => string } {
  let output = "";
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    } as NodeJS.WritableStream,
    read: () => output,
  };
}

/** Build the localhost agent API without starting a listener. */
export function createCliServer(ctx: CliContext, opts: CliServerOptions = {}): Server {
  const authToken = opts.authToken ?? process.env.DEYIN_SERVER_TOKEN?.trim() ?? undefined;
  return createServer(async (req, res) => {
    try {
      if (!authorized(req, authToken)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true, version: VERSION, cwd: ctx.cwd });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const models = await listModels(ctx.config, async () => {
          try {
            if (!(await ctx.oauth.isAuthenticated())) return null;
            return await ctx.oauth.getAccessToken();
          } catch {
            return null;
          }
        });
        json(res, 200, { models });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/capabilities") {
        const caps = await loadCliCapabilities({ cwd: ctx.cwd, dataDir: ctx.dataDir, trustedWorkspace: url.searchParams.get("trust") === "1" });
        json(res, 200, {
          plugins: caps.plugins,
          skills: caps.skills,
          commands: caps.commands,
          subagents: caps.subagents,
          hooks: caps.hooks,
          mcpServers: caps.mcpServers,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/run") {
        const input = await body(req);
        if (!input || typeof input !== "object" || typeof (input as { prompt?: unknown }).prompt !== "string") {
          json(res, 400, { error: "prompt must be a string" });
          return;
        }
        const request = input as {
          prompt: string;
          yes?: boolean;
          continueLast?: boolean;
          resumeId?: string;
          maxSteps?: number;
          trustWorkspace?: boolean;
        };
        const out = capture();
        const errors = capture();
        const exitCode = await runHeadless({
          ctx,
          prompt: request.prompt,
          json: true,
          yes: request.yes === true,
          continueLast: request.continueLast === true,
          resumeId: request.resumeId,
          maxSteps: request.maxSteps,
          trustWorkspace: request.trustWorkspace === true,
          stdout: out.stream,
          stderr: errors.stream,
        });
        res.writeHead(exitCode === 0 ? 200 : 500, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "x-deyin-exit-code": String(exitCode),
        });
        res.end(out.read() || JSON.stringify({ type: "error", error: errors.read() }));
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Start the localhost API and keep it alive until SIGINT/SIGTERM. */
export async function serveCli(ctx: CliContext, opts: CliServerOptions = {}): Promise<number> {
  const server = createCliServer(ctx, opts);
  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? 7789;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.error(`deyin serve listening on http://${hostname}:${actualPort}`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
