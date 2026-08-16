import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocket } from "ws";
import { Session } from "../src/server/session.js";
import type { AgentEventEnvelope } from "@deyin/host-core/shared";
import type { ServerMessage } from "../src/shared/protocol.js";

/**
 * Full WS round-trip: mock OAuth introspection + mock model provider, then
 * auth → agent.start → agent.event stream → done over one socket.
 */

function httpHandler(issuerBodies: { introspect: unknown; completions: unknown[] }) {
  return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    if (req.url?.endsWith("/oauth/introspect")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(issuerBodies.introspect));
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of issuerBodies.completions) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404).end();
  };
}

interface TestSocket {
  server: Server;
  url: string;
  /** Mock model-provider base URL (also serves OAuth introspection). */
  providerUrl: string;
  close: () => Promise<void>;
}

async function startServices(): Promise<TestSocket> {
  const provider = createServer(httpHandler({
    introspect: { active: true, sub: "user-1", plan: "individual" },
    completions: [
      { choices: [{ delta: { content: "ws ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ],
  }));
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = (provider.address() as AddressInfo).port;

  const wsServer = createServer();
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ noServer: true });
  wsServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  const sessions = new Set<Session>();
  wss.on("connection", (ws) => {
    const session = new Session(ws as unknown as import("ws").WebSocket, `http://127.0.0.1:${providerPort}`);
    sessions.add(session);
    ws.on("message", (raw) => void session.handle(raw.toString()));
    ws.on("close", () => {
      session.dispose();
      sessions.delete(session);
    });
  });
  await new Promise<void>((resolve) => wsServer.listen(0, "127.0.0.1", resolve));
  const wsPort = (wsServer.address() as AddressInfo).port;

  return {
    server: wsServer,
    url: `ws://127.0.0.1:${wsPort}`,
    providerUrl: `http://127.0.0.1:${providerPort}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions) s.dispose();
        wss.close();
        provider.close();
        wsServer.close(() => resolve());
      }),
  };
}

test("session WS: auth → agent.start → events → done", async () => {
  const services = await startServices();
  try {
    const ws = new WebSocket(services.url);
    const messages: ServerMessage[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 15_000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as ServerMessage;
        messages.push(msg);
        if (msg.type === "agent.event" && msg.envelope.event.type === "done") {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on("error", reject);
    });
    await new Promise<void>((resolve) => ws.once("open", resolve));

    ws.send(JSON.stringify({ type: "auth", token: "valid-for-mock" }));
    await new Promise<void>((resolve) => {
      const wait = setInterval(() => {
        if (messages.some((m) => m.type === "auth.ok")) {
          clearInterval(wait);
          resolve();
        }
      }, 20);
    });

    ws.send(JSON.stringify({
      type: "agent.start",
      id: 1,
      threadId: "t1",
      prompt: "hi",
      model: "m",
      thinking: false,
      approvalMode: "full-access",
      mode: "agent",
      history: [],
      provider: { baseUrl: services.providerUrl, token: "t", apiFormat: "chat-completions" },
    }));

    await done;

    const agentEvents = messages
      .filter((m): m is Extract<ServerMessage, { type: "agent.event" }> => m.type === "agent.event")
      .map((m) => m.envelope as AgentEventEnvelope);
    assert.ok(agentEvents.some((e) => e.event.type === "text-delta"), "text streamed");
    assert.ok(agentEvents.some((e) => e.event.type === "done"), "done arrived");
    const replies = messages.filter((m) => m.type === "reply");
    assert.ok(replies.length >= 1, "agent.start acknowledged");
    ws.close();
  } finally {
    await services.close();
  }
});
