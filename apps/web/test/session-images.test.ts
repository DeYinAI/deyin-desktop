import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocket } from "ws";
import { Session } from "../src/server/session.js";
import type { ServerMessage } from "@deyin/contract/web";

/** 1x1 transparent PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface TestServices {
  url: string;
  providerUrl: string;
  close: () => Promise<void>;
}

/** Mock issuer + images endpoint behind one WS-hosted Session. */
async function startServices(): Promise<TestServices> {
  const provider = createServer((req, res) => {
    if (req.url?.endsWith("/oauth/introspect")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ active: true, sub: "user-1", plan: "individual" }));
      return;
    }
    if (req.url?.endsWith("/images/generations")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = (provider.address() as AddressInfo).port;

  const wsServer: Server = createServer();
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

test("session WS: images.generate stores the picture and images.read returns a data URL", async () => {
  const services = await startServices();
  const ws = new WebSocket(services.url);
  const messages: ServerMessage[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));

  const reply = (id: number) =>
    new Promise<Extract<ServerMessage, { type: "reply" }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`reply ${id} timed out`)), 10_000);
      const wait = setInterval(() => {
        const found = messages.find((m): m is Extract<ServerMessage, { type: "reply" }> => m.type === "reply" && m.id === id);
        if (found) {
          clearInterval(wait);
          clearTimeout(timer);
          resolve(found);
        }
      }, 20);
    });

  try {
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

    ws.send(
      JSON.stringify({
        type: "images.generate",
        id: 1,
        threadId: "t1",
        prompt: "a red fox in fog",
        model: "SDXL Lightning",
        provider: { baseUrl: services.providerUrl, token: "t", apiFormat: "chat-completions" },
      }),
    );
    const generated = await reply(1);
    assert.equal(generated.ok, true);
    const result = (generated as { result: { images: { file: string }[]; model: string } }).result;
    assert.equal(result.model, "SDXL Lightning");
    assert.equal(result.images.length, 1);
    const file = result.images[0]!.file;

    ws.send(JSON.stringify({ type: "images.read", id: 2, threadId: "t1", file }));
    const read = await reply(2);
    assert.equal(read.ok, true);
    assert.equal((read as { result: { dataUrl: string } }).result.dataUrl, `data:image/png;base64,${PNG}`);
  } finally {
    ws.close();
    await services.close();
  }
});
