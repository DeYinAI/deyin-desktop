import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { createContext } from "./context.js";
import { runHeadless } from "./headless.js";
import type { CliContext } from "./context.js";
import { VERSION } from "./version.js";
import type { AgentImage } from "@deyin/agent-core";
import { BUILD_AGENT, buildSystemPrompt, loadContextFiles, resolveAgent, type AgentMessage } from "@deyin/agent-core";
import { loadCliCapabilities } from "./capabilities.js";

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

async function createAcpSession(ctx: CliContext, cwd: string): Promise<{ id: string; context: CliContext }> {
  const context = cwd === ctx.cwd ? ctx : createContext({ cwd });
  const agent = resolveAgent(context.config, context.config.agent) ?? BUILD_AGENT;
  const caps = await loadCliCapabilities({ cwd, dataDir: context.dataDir, trustedWorkspace: false });
  const contextFiles = await loadContextFiles(cwd);
  const meta = context.sessions.create({
    cwd,
    model: `${context.config.providerId}::${context.config.model}`,
    agent: agent.name,
  });
  context.sessions.append(meta.id, {
    role: "system",
    content: buildSystemPrompt({ cwd, agent, contextFiles, skills: caps.skills }),
  });
  return { id: meta.id, context };
}

function replaySession(sessionId: string, messages: AgentMessage[]): void {
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content : "";
    if (!text) continue;
    update(sessionId, {
      sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
      messageId: randomUUID(),
      content: { type: "text", text },
    });
  }
}

function promptContent(prompt: unknown): { text: string; images: AgentImage[] } {
  if (!Array.isArray(prompt)) return { text: typeof prompt === "string" ? prompt : "", images: [] };
  const parts: string[] = [];
  const images: AgentImage[] = [];
  for (const block of prompt) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: string; text?: unknown; resource?: { text?: unknown; uri?: string } };
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    if (item.type === "resource" && typeof item.resource?.text === "string") {
      parts.push(`--- ${item.resource.uri ?? "resource"} ---\n${item.resource.text}`);
    }
    if (item.type === "image") {
      const image = item as { data?: unknown; mimeType?: unknown };
      if (typeof image.data === "string") {
        const mediaType = typeof image.mimeType === "string" ? image.mimeType : "image/png";
        if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
          images.push({ mediaType: mediaType as AgentImage["mediaType"], base64: image.data });
          parts.push(`[Attached image: ${mediaType}]`);
        }
      }
    }
  }
  return { text: parts.join("\n\n"), images };
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
  const tasks = new Set<Promise<void>>();
  for await (const line of input) {
    if (!line.trim()) continue;
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      continue;
    }
    const task = (async (): Promise<void> => {
      const id = request.id;
      try {
      if (request.method === "initialize") {
        response(id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, embeddedContext: true },
            mcpCapabilities: { http: true, sse: true },
            sessionCapabilities: { resume: {} },
          },
          agentInfo: { name: "deyin", title: "DeYin CLI", version: VERSION },
          authMethods: [],
        });
        return;
      }
      if (request.method === "session/new") {
        const params = (request.params ?? {}) as { cwd?: unknown };
        const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : ctx.cwd;
        const session = await createAcpSession(ctx, cwd);
        const sid = session.id;
        sessions.set(sid, { cwd });
        response(id, { sessionId: sid });
        return;
      }
      if (request.method === "session/load" || request.method === "session/resume") {
        const sid = sessionId(request.params);
        const loaded = sid ? ctx.sessions.load(sid) : null;
        if (!sid || (!sessions.has(sid) && !loaded)) {
          error(id, -32602, "unknown session");
        } else {
          if (loaded && !sessions.has(sid)) sessions.set(sid, { cwd: loaded.meta.cwd, internalId: sid });
          if (request.method === "session/load" && loaded) replaySession(sid, loaded.messages);
          response(id, request.method === "session/load" ? null : {});
        }
        return;
      }
      if (request.method === "session/cancel") {
        const sid = sessionId(request.params);
        sessions.get(sid ?? "")?.abort?.abort();
        response(id, {});
        return;
      }
      if (request.method === "session/prompt") {
        const sid = sessionId(request.params);
        const state = sid ? sessions.get(sid) : undefined;
        const content = promptContent((request.params as { prompt?: unknown } | undefined)?.prompt);
        if (!sid || !state || (!content.text && content.images.length === 0)) {
          error(id, -32602, "sessionId and a non-empty prompt are required");
          return;
        }
        const abort = new AbortController();
        state.abort = abort;
        const messageId = randomUUID();
        const toolCalls = new Map<string, string>();
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
                const event = JSON.parse(eventLine) as {
                  type?: string;
                  delta?: string;
                  text?: string;
                  sessionId?: string;
                  tool?: string;
                  name?: string;
                  result?: string;
                  finalText?: string;
                  call?: { id?: string; name?: string };
                };
                if (event.type === "text-delta" && typeof event.delta === "string") {
                  finalText += event.delta;
                  update(sid, { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: event.delta } });
                } else if (event.type === "tool-start") {
                  const sourceId = event.call?.id ?? randomUUID();
                  const toolCallId = randomUUID();
                  toolCalls.set(sourceId, toolCallId);
                  update(sid, { sessionUpdate: "tool_call", toolCallId, title: event.call?.name ?? event.tool ?? event.name ?? "tool", kind: "other", status: "in_progress" });
                } else if (event.type === "tool-end") {
                  const sourceId = event.call?.id;
                  const toolCallId = (sourceId && toolCalls.get(sourceId)) ?? randomUUID();
                  if (sourceId) toolCalls.delete(sourceId);
                  update(sid, { sessionUpdate: "tool_call", toolCallId, title: event.call?.name ?? event.tool ?? event.name ?? "tool", kind: "other", status: "completed", rawOutput: event.result ?? "" });
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
          prompt: content.text || "Please inspect the attached image.",
          images: content.images,
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
        return;
      }
      error(id, -32601, `method not found: ${request.method ?? ""}`);
      } catch (err) {
        error(id, -32000, err instanceof Error ? err.message : String(err));
      }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }
  await Promise.all(tasks);
  return 0;
}
