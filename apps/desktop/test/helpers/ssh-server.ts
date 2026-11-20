import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import ssh2, { type Connection } from "ssh2";
const { Server, utils } = ssh2;
import { hostFingerprint } from "../../src/main/automations/ssh-client.js";

export interface TestSshServer {
  port: number;
  password: string;
  username: string;
  /** What a client sees as the server's host key fingerprint. */
  fingerprint: string;
  /** Every command a client asked to run, in order. */
  execs: string[];
  /** Destination ports of the forwards a client opened. */
  forwards: number[];
  /** Cut every open connection, as a network failure would. */
  dropConnections(): void;
  close(): Promise<void>;
}

/**
 * ssh2 now and then produces a public key it cannot read back, which would fail a test
 * for no reason of its own. A key that reads back is the only one worth serving.
 */
function generateHostKey(): { private: string; blob: ReturnType<typeof utils.parseKey> & object } {
  let failure: Error | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const key = utils.generateKeyPairSync("ed25519");
    const parsed = utils.parseKey(key.public);
    if (!(parsed instanceof Error)) return { private: key.private, blob: parsed };
    failure = parsed;
  }
  throw failure ?? new Error("could not make a host key");
}

/**
 * A real SSH server on this machine's loopback, for testing the desktop's SSH code end to end. It takes one login,
 * runs `exec` requests as local shell commands in `env`, and opens forwards to loopback ports.
 */
export async function startSshServer(options: { env: NodeJS.ProcessEnv; cwd: string }): Promise<TestSshServer> {
  const hostKey = generateHostKey();
  const username = "tester";
  const password = "correct horse";
  const connections = new Set<Connection>();
  const sockets = new Set<Socket>();
  const execs: string[] = [];
  const forwards: number[] = [];

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    connections.add(client);
    client.on("close", () => connections.delete(client));
    client.on("error", () => undefined);
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === username && ctx.password === password) ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("exec", (acceptExec, _reject, info) => {
          execs.push(info.command);
          const stream = acceptExec();
          const child = spawn("sh", ["-c", info.command], { env: options.env, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
          child.stdout.on("data", (chunk) => stream.write(chunk));
          child.stderr.on("data", (chunk) => stream.stderr.write(chunk));
          stream.on("data", (chunk: Buffer) => child.stdin.write(chunk));
          stream.on("end", () => child.stdin.end());
          const killGroup = (): void => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              // already gone
            }
          };
          stream.on("close", killGroup);
          child.stdin.on("error", () => undefined);
          child.on("close", (code, signal) => {
            stream.exit(code ?? (signal ? 143 : 1));
            stream.end();
          });
        });
      });
      client.on("tcpip", (acceptForward, rejectForward, info) => {
        if (info.destIP !== "127.0.0.1") {
          rejectForward();
          return;
        }
        forwards.push(info.destPort);
        const socket = connect(info.destPort, info.destIP);
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.once("error", () => rejectForward());
        socket.once("connect", () => {
          const channel = acceptForward();
          channel.pipe(socket);
          socket.pipe(channel);
          channel.on("error", () => socket.destroy());
          socket.on("error", () => channel.destroy());
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    username,
    password,
    fingerprint: hostFingerprint(hostKey.blob.getPublicSSH()),
    execs,
    forwards,
    dropConnections: () => {
      for (const connection of connections) connection.end();
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      for (const connection of connections) connection.end();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
