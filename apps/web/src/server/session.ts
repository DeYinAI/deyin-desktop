import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { SessionHost } from "./host.js";
import { introspect } from "./introspect.js";

/**
 * Drives one authenticated WebSocket connection: validates the token, provisions a
 * sandbox root, and dispatches host RPCs. In production the sandbox root is a container
 * volume; here it is a temp workspace.
 */
export class Session {
  private host?: SessionHost;
  private authed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly issuer: string,
  ) {}

  send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async handle(raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    if (msg.type === "auth") {
      const result = await introspect(this.issuer, msg.token);
      if (!result.active) {
        this.send({ type: "auth.err", message: "Invalid or expired token." });
        this.ws.close();
        return;
      }
      const root = await mkdtemp(join(tmpdir(), "deyin-session-"));
      this.host = new SessionHost(root, (m) => this.send(m));
      this.authed = true;
      this.send({ type: "auth.ok", user: { sub: result.sub ?? "unknown", plan: result.plan } });
      return;
    }

    if (!this.authed || !this.host) {
      this.send({ type: "auth.err", message: "Not authenticated." });
      return;
    }

    try {
      switch (msg.type) {
        case "files.tree":
          this.send({ type: "reply", id: msg.id, ok: true, result: { nodes: await this.host.tree(msg.dir) } });
          break;
        case "files.read":
          this.send({ type: "reply", id: msg.id, ok: true, result: { content: await this.host.read(msg.path) } });
          break;
        case "env.detect":
          this.send({ type: "reply", id: msg.id, ok: true, result: { env: this.host.env() } });
          break;
        case "term.create":
          this.send({ type: "reply", id: msg.id, ok: true, result: { termId: await this.host.createTerminal(msg.opts) } });
          break;
        case "term.write":
          this.host.writeTerminal(msg.termId, msg.data);
          break;
        case "term.resize":
          this.host.resizeTerminal(msg.termId, msg.cols, msg.rows);
          break;
        case "term.kill":
          this.host.killTerminal(msg.termId);
          break;
      }
    } catch (err) {
      if ("id" in msg && typeof msg.id === "number") {
        this.send({ type: "reply", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  dispose(): void {
    this.host?.dispose();
  }
}
