import { Agent } from "node:http";
import type { Duplex } from "node:stream";
import { BotError, type EngineRegistration } from "@deyin/host-core";
import { EngineClient } from "./client.js";

/**
 * What a link needs of an SSH connection, so it can be tested without a server. ssh2's `Client` is one: it can open a
 * channel to a port on the far side, and says when it has gone.
 */
export interface ForwardingConnection {
  forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number, callback: (err: Error | undefined, channel: Duplex) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  end(): void;
}

/**
 * A channel is a stream, not a socket. HTTP asks a socket for a few things a channel has no use for; answer them with
 * nothing, and leave alone any the channel already has.
 */
function asSocket(channel: Duplex): Duplex {
  const socket = channel as Duplex & Record<string, unknown>;
  for (const name of ["setNoDelay", "setKeepAlive", "ref", "unref"]) {
    if (typeof socket[name] !== "function") socket[name] = () => socket;
  }
  if (typeof socket.setTimeout !== "function") socket.setTimeout = () => socket;
  return channel;
}

/**
 * An HTTP agent whose every connection is a fresh channel through the SSH connection to the engine's port on the
 * server's own loopback. No connection is reused (`keepAlive` is off), so a channel the far side dropped never
 * gets a second request.
 */
export function forwardAgent(connection: ForwardingConnection, port: number): Agent {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    connection.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, channel) => {
      if (error) callback?.(error, undefined as never);
      else callback?.(null, asSocket(channel));
    });
    return undefined;
  };
  return agent;
}

export interface EngineLinksDeps {
  /** An SSH connection to the server with its host key already pinned; a refusal is thrown. */
  connect(hostId: string): Promise<ForwardingConnection>;
  registry: {
    get(hostId: string): EngineRegistration | undefined;
    token(hostId: string): string | null;
  };
  /** What the server is called, for the messages a person reads. */
  labelOf(hostId: string): string;
}

interface Link {
  connection: ForwardingConnection;
  agent: Agent;
  client: EngineClient;
  port: number;
  token: string;
}

/**
 * The desktop's connections to its engines, one per server: connected when first wanted, kept while they hold, and
 * made again when the connection drops or the engine's port or key changes. A failed connect is not remembered.
 */
export class EngineLinks {
  private readonly links = new Map<string, Link>();
  private readonly connecting = new Map<string, Promise<Link>>();
  /** Bumped by `close`, so a connection that finishes opening after it was closed is dropped and not kept. */
  private readonly closings = new Map<string, number>();

  constructor(private readonly deps: EngineLinksDeps) {}

  /** A client for the engine on this server, connecting first if there is no live connection. */
  async client(hostId: string): Promise<EngineClient> {
    const registration = this.deps.registry.get(hostId);
    const label = this.deps.labelOf(hostId);
    if (!registration) throw new BotError("not_found", `No Bot engine is set up on ${label}. Set one up under Settings, Servers.`);
    const token = this.deps.registry.token(hostId);
    if (!token) throw new BotError("conflict", `The key for the Bot engine on ${label} can no longer be read. Set the engine up again.`);

    const current = this.links.get(hostId);
    if (current && current.port === registration.port && current.token === token) return current.client;
    if (current) this.close(hostId);

    const waiting = this.connecting.get(hostId);
    if (waiting) {
      const link = await waiting;
      if (link.port === registration.port && link.token === token) return link.client;
      return this.client(hostId);
    }
    const attempt = this.open(hostId, registration.port, token, label);
    this.connecting.set(hostId, attempt);
    try {
      return (await attempt).client;
    } finally {
      this.connecting.delete(hostId);
    }
  }

  /** Whether a live connection to this server's engine is open right now. */
  isConnected(hostId: string): boolean {
    return this.links.has(hostId);
  }

  /** Close the connection to one server, e.g. when its engine is removed. The next call connects again. */
  close(hostId: string): void {
    this.closings.set(hostId, (this.closings.get(hostId) ?? 0) + 1);
    const link = this.links.get(hostId);
    if (!link) return;
    this.links.delete(hostId);
    link.agent.destroy();
    link.connection.end();
  }

  closeAll(): void {
    for (const hostId of [...this.links.keys()]) this.close(hostId);
  }

  private async open(hostId: string, port: number, token: string, label: string): Promise<Link> {
    const closings = this.closings.get(hostId) ?? 0;
    let connection: ForwardingConnection;
    try {
      connection = await this.deps.connect(hostId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BotError("conflict", `Could not connect to ${label}: ${detail}`);
    }
    if ((this.closings.get(hostId) ?? 0) !== closings) {
      connection.end();
      throw new BotError("conflict", `The connection to ${label} was closed before it was ready.`);
    }
    const agent = forwardAgent(connection, port);
    const link: Link = { connection, agent, client: new EngineClient({ host: "127.0.0.1", port, token, agent, label }), port, token };
    const gone = (): void => {
      // Only forget this connection; a newer one for the same server may already be in place.
      if (this.links.get(hostId) !== link) return;
      this.links.delete(hostId);
      agent.destroy();
    };
    connection.on("close", gone);
    connection.on("error", gone);
    this.links.set(hostId, link);
    return link;
  }
}
