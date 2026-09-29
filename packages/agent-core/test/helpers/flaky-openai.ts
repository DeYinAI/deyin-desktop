import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * What one scripted request does on the wire. Unlike `startMockOpenAI` (which
 * always answers 200 and ends cleanly), this can misbehave the way real
 * providers and gateways do: fail, drop the socket mid-response, go silent, or
 * end a stream without the `[DONE]` sentinel.
 */
export type WireBehavior =
  /** A well-formed SSE reply. `done: false` omits the `[DONE]` sentinel and just closes. */
  | { kind: "events"; events: unknown[]; done?: boolean }
  /** An HTTP error before any stream starts. */
  | { kind: "http-error"; status: number; body?: string; headers?: Record<string, string> }
  /** Some SSE frames, then the socket is destroyed mid-response. */
  | { kind: "drop"; events: unknown[] }
  /** Some SSE frames, then silence on an open connection. */
  | { kind: "stall"; events: unknown[] };

export type WireScript = (requestIndex: number, body: Record<string, unknown>) => WireBehavior;

function writeFrames(res: ServerResponse, events: unknown[]): void {
  for (const event of events) {
    res.write(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
  }
}

export async function startFlakyOpenAI(script: WireScript): Promise<{
  url: string;
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
}> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const index = requests.length;
      requests.push(body);
      const behavior = script(index, body);
      switch (behavior.kind) {
        case "http-error":
          res.writeHead(behavior.status, { "content-type": "application/json", ...behavior.headers });
          res.end(behavior.body ?? JSON.stringify({ error: { message: `mock failure ${behavior.status}` } }));
          return;
        case "events":
          res.writeHead(200, { "content-type": "text/event-stream" });
          writeFrames(res, behavior.events);
          if (behavior.done !== false) res.write("data: [DONE]\n\n");
          res.end();
          return;
        case "drop":
          res.writeHead(200, { "content-type": "text/event-stream" });
          writeFrames(res, behavior.events);
          // Give the frames a moment to flush before the socket is torn down mid-response.
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        case "stall":
          res.writeHead(200, { "content-type": "text/event-stream" });
          writeFrames(res, behavior.events);
          return; // never ended; close() tears the socket down
        default: {
          const unreachable: never = behavior;
          return unreachable;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        // Stalled connections would otherwise keep close() waiting forever.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
