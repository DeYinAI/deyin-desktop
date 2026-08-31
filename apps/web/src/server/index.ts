import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { webSearch } from "@deyin/host-core";
import { WebSocketServer } from "ws";
import { Session } from "./session.js";

const PORT = Number(process.env.PORT ?? 8790);
const OAUTH_ISSUER = process.env.DEYIN_OAUTH_ISSUER ?? "https://openference.com";
const OPENFERENCE_API = process.env.DEYIN_API_BASE_URL ?? "https://api.openference.com/v1";

/**
 * Deyin web host-server: WebSocket host services at /host, and an HTTP proxy at /api/*
 * that forwards the caller's Bearer token to Openference (keeps the browser off
 * cross-origin calls and centralizes token handling).
 */
const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Built-in free web search: handled locally, never proxied upstream.
  if (req.url?.startsWith("/api/search")) {
    void handleSearch(req, res);
    return;
  }
  if (req.url?.startsWith("/api/public/plans")) {
    void proxyPublicPlans(req, res);
    return;
  }
  if (req.url?.startsWith("/api/")) {
    void proxyToOpenference(req, res);
    return;
  }
  res.writeHead(404).end();
});

async function handleSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.headers.authorization) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing_authorization" }));
    return;
  }
  const q = new URL(req.url ?? "", "http://localhost").searchParams.get("q") ?? "";
  try {
    const results = await webSearch(q);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results }));
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

const wss = new WebSocketServer({ server: httpServer, path: "/host" });
wss.on("connection", (ws) => {
  const session = new Session(ws, OAUTH_ISSUER);
  ws.on("message", (data) => void session.handle(data.toString()));
  ws.on("close", () => session.dispose());
  ws.on("error", () => session.dispose());
});

/** Public pricing catalog (no auth); browser cannot call the issuer origin directly (CORS). */
async function proxyPublicPlans(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const search = new URL(req.url ?? "", "http://localhost").search;
  const upstream = await fetch(`${OAUTH_ISSUER.replace(/\/$/, "")}/api/public/plans${search}`, {
    method: req.method,
  });

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  if (upstream.body) {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
}

async function proxyToOpenference(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const upstreamPath = req.url!.replace(/^\/api/, "");
  const auth = req.headers.authorization;
  if (!auth) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing_authorization" }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  const upstream = await fetch(`${OPENFERENCE_API}${upstreamPath}`, {
    method: req.method,
    headers: {
      authorization: auth,
      "content-type": req.headers["content-type"] ?? "application/json",
    },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  if (upstream.body) {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
}

httpServer.listen(PORT, () => {
  console.log(`[deyin host-server] http+ws on :${PORT}  (issuer=${OAUTH_ISSUER})`);
});
