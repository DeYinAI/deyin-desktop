import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { createContext } from "./context.js";
import { runHeadless } from "./headless.js";
import type { CliContext } from "./context.js";
import { VERSION } from "./version.js";

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
type SessionState = { cwd: string; internalId?: string; abort?: AbortController };

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id: RpcRequest["id"], result: unknown): void {
  if (id === undefined || id === null) return;
  write({ jsonrpc: "2.0", id, result });
}

function error(id: RpcRequest["id"], code: number, message: string): void {
  if (id === undefined || id === null) return;
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function update(sessionId: string, value: Record<string, unknown>): void {
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return typeof prompt === "string" ? prompt : "";
  const parts: string[] = [];
  for (const block of prompt) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: string; text?: unknown; resource?: { text?: unknown; uri?: string } };
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    if (item.type === "resource" && typeof item.resource?.text === "string") {
      parts.push(`--- ${item.resource.uri ?? "resource"} ---\n${item.resource.text}`);
    }
  }
  return parts.join("\n\n");
}

function sessionId(params: unknown): string | undefined {
  return params && typeof params === "object" && typeof (params as { sessionId?: unknown }).sessionId === "string"
    ? (params as { sessionId: string }).sessionId
    : undefined;
}

/** Serve ACP v1 JSON-RPC over stdin/stdout for editor integrations. */
export async function runAcp(ctx: CliContext): Promise<number> {
  const sessions = new Map<string, SessionState>();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      continue;
    }
    const id = request.id;
    try {
      if (request.method === "initialize") {
        response(id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: true, embeddedContext: true },
            mcpCapabilities: { http: true, sse: true },
          },
          agentInfo: { name: "deyin", title: "DeYin CLI", version: VERSION },
          authMethods: [],
        });
        continue;
      }
      if (request.method === "session/new") {
        const params = (request.params ?? {}) as { cwd?: unknown };
        const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : ctx.cwd;
        const sid = `sess_${randomUUID().replaceAll("-", "")}`;
        sessions.set(sid, { cwd });
        response(id, { sessionId: sid });
        continue;
      }
      if (request.method === "session/load" || request.method === "session/resume") {
        const sid = sessionId(request.params);
        if (!sid || !sessions.has(sid)) {
          error(id, -32602, "unknown session");
        } else {
          response(id, {});
        }
        continue;
      }
      if (request.method === "session/cancel") {
        const sid = sessionId(request.params);
        sessions.get(sid ?? "")?.abort?.abort();
        response(id, {});
        continue;
      }
      if (request.method === "session/prompt") {
        const sid = sessionId(request.params);
        const state = sid ? sessions.get(sid) : undefined;
        const prompt = promptText((request.params as { prompt?: unknown } | undefined)?.prompt);
        if (!sid || !state || !prompt) {
          error(id, -32602, "sessionId and a non-empty prompt are required");
          continue;
        }
        const abort = new AbortController();
        state.abort = abort;
        const messageId = randomUUID();
        let finalText = "";
        let pending = "";
        const output = {
          write(chunk: string | Uint8Array): boolean {
            const raw = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            pending += raw;
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const eventLine of lines) {
              if (!eventLine.trim()) continue;
              try {
                const event = JSON.parse(eventLine) as { type?: string; delta?: string; text?: string; sessionId?: string; tool?: string; name?: string; result?: string; finalText?: string };
                if (event.type === "text-delta" && typeof event.delta === "string") {
                  finalText += event.delta;
                  update(sid, { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: event.delta } });
                } else if (event.type === "tool-start") {
                  update(sid, { sessionUpdate: "tool_call", toolCallId: randomUUID(), title: event.tool ?? event.name ?? "tool", kind: "other", status: "in_progress" });
                } else if (event.type === "tool-end") {
                  update(sid, { sessionUpdate: "tool_call", toolCallId: randomUUID(), title: event.tool ?? event.name ?? "tool", kind: "other", status: "completed", rawOutput: event.result ?? "" });
                } else if (event.type === "result" && typeof event.sessionId === "string") {
                  state.internalId = event.sessionId;
                  if (typeof event.finalText === "string") finalText = event.finalText;
                }
              } catch {
                // A partial chunk is completed by the next write.
              }
            }
            return true;
          },
        } as unknown as NodeJS.WritableStream;
        const exitCode = await runHeadless({
          ctx: state.cwd === ctx.cwd ? ctx : createContext({ cwd: state.cwd }),
          prompt,
          json: true,
          yes: true,
          resumeId: state.internalId,
          signal: abort.signal,
          stdout: output,
          stderr: { write: () => true } as unknown as NodeJS.WritableStream,
        });
        state.abort = undefined;
        if (exitCode === 130 || abort.signal.aborted) response(id, { stopReason: "cancelled" });
        else if (exitCode !== 0) error(id, -32000, `agent exited with code ${exitCode}`);
        else response(id, { stopReason: "end_turn", ...(finalText ? { _meta: { finalText } } : {}) });
        continue;
      }
      error(id, -32601, `method not found: ${request.method ?? ""}`);
    } catch (err) {
      error(id, -32000, err instanceof Error ? err.message : String(err));
    }
  }
  return 0;
}
