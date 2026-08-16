import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { SessionHost } from "./host.js";
import { WebAgentHost, type WebAgentStartOptions } from "./agent-host.js";
import { introspect } from "./introspect.js";

/**
 * Drives one authenticated WebSocket connection: validates the token, provisions a
 * sandbox root, and dispatches host RPCs. In production the sandbox root is a container
 * volume; here it is a temp workspace.
 */
export class Session {
  private host?: SessionHost;
  private agentHost?: WebAgentHost;
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
      this.agentHost = new WebAgentHost(
        root,
        this.host.terminalManager,
        (envelope) => this.send({ type: "agent.event", envelope }),
        (m) => this.send(m),
      );
      this.authed = true;
      this.send({ type: "auth.ok", user: { sub: result.sub ?? "unknown", plan: result.plan }, workspaceRoot: root });
      return;
    }

    if (!this.authed || !this.host || !this.agentHost) {
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
        case "files.write":
          await this.host.write(msg.path, msg.content);
          this.send({ type: "reply", id: msg.id, ok: true, result: { ok: true } });
          break;
        case "env.detect":
          this.send({ type: "reply", id: msg.id, ok: true, result: { env: await this.host.env() } });
          break;
        case "term.create":
          this.send({ type: "reply", id: msg.id, ok: true, result: { termId: await this.host.createTerminal(msg.opts) } });
          break;
        case "term.attach":
          this.send({ type: "reply", id: msg.id, ok: true, result: this.host.attachTerminal(msg.termId) });
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
        case "agent.start": {
          const options = msg as WebAgentStartOptions & { type: "agent.start"; id: number };
          this.agentHost.start({
            threadId: options.threadId,
            prompt: options.prompt,
            model: options.model,
            thinking: options.thinking,
            approvalMode: options.approvalMode,
            mode: options.mode,
            history: options.history,
            provider: options.provider,
          });
          this.send({ type: "reply", id: msg.id, ok: true, result: undefined });
          break;
        }
        case "agent.stop":
          this.agentHost.stop(msg.threadId);
          break;
        case "agent.approve":
          this.agentHost.approve(msg.requestId, msg.decision);
          break;
        case "agent.answer":
          this.agentHost.answerQuestion(msg.requestId, msg.answers);
          break;
      }
    } catch (err) {
      if ("id" in msg && typeof msg.id === "number") {
        this.send({ type: "reply", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  dispose(): void {
    this.agentHost?.dispose();
    this.host?.dispose();
  }
}
