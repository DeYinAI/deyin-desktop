import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { HostCancelledError, HostRpcError, PipeComputerUseHost } from "../src/pipe-host.js";
import { METHOD_TIMEOUT_MS, RPC_CODES } from "../src/protocol.js";

interface Request {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** A stand-in for the C# host: listens on a local socket and lets each test decide how to answer. */
class FakeHost {
  readonly requests: Request[] = [];
  readonly sockets = new Set<Socket>();
  readonly path: string;
  private readonly server: Server;
  private readonly dir: string | null;
  connections = 0;

  constructor(private readonly onRequest: (request: Request, reply: Reply, socket: Socket) => void) {
    if (process.platform === "win32") {
      this.dir = null;
      this.path = `\\\\.\\pipe\\deyin-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
    } else {
      this.dir = mkdtempSync(join(tmpdir(), "deyin-cu-"));
      this.path = join(this.dir, "host.sock");
    }
    this.server = createServer((socket) => {
      this.connections += 1;
      this.sockets.add(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          const request = JSON.parse(line) as Request;
          this.requests.push(request);
          this.onRequest(request, reply(socket, request), socket);
        }
      });
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => undefined);
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.path, resolve));
  }

  event(type: string, data?: unknown): void {
    for (const socket of this.sockets) {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, data } })}\n`);
    }
  }

  methods(): string[] {
    return this.requests.map((r) => r.method);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}

interface Reply {
  result(value: unknown): void;
  error(code: number, message: string): void;
}

function reply(socket: Socket, request: Request): Reply {
  return {
    result: (value) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: value })}\n`),
    error: (code, message) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message } })}\n`),
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  mock.timers.reset();
  while (cleanups.length) await cleanups.pop()?.();
});

async function connect(onRequest: ConstructorParameters<typeof FakeHost>[0]) {
  const fake = new FakeHost(onRequest);
  await fake.listen();
  const host = new PipeComputerUseHost({ hostExe: "unused", shotsDir: "unused", pipePath: fake.path });
  cleanups.push(() => host.dispose(), () => fake.close());
  return { fake, host };
}

const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("a request goes out as JSON-RPC and its result comes back", async () => {
  const { fake, host } = await connect((req, r) => r.result([{ id: "1", title: "Notes" }]));
  const windows = await host.listWindows();
  assert.deepEqual(windows, [{ id: "1", title: "Notes" }]);
  assert.equal(fake.requests[0]?.method, "list_windows");
});

test("parameters are passed through by name", async () => {
  const { fake, host } = await connect((req, r) => r.result({ ok: true, method: "msg" }));
  await host.click("42", { ref: "s1e2", button: "right", count: 2, modifiers: ["ctrl"], method: "input" });
  assert.deepEqual(fake.requests[0]?.params, { windowId: "42", ref: "s1e2", button: "right", count: 2, modifiers: ["ctrl"], method: "input" });
  await host.getWindowState("42", { screenshot: false, depth: 2, query: "Save" });
  assert.deepEqual(fake.requests[1]?.params, { windowId: "42", screenshot: false, depth: 2, query: "Save" });
});

test("host errors keep their code, and a cancel is its own error type", async () => {
  const { host } = await connect((req, r) => {
    if (req.method === "get_window") r.error(RPC_CODES.notFound, "Window not found or closed: 9");
    else if (req.method === "click") r.error(RPC_CODES.tookOver, "The user took over the mouse or keyboard.");
    else r.error(RPC_CODES.cancelled, "Cancelled");
  });
  await assert.rejects(host.getWindow("9"), (e: unknown) => e instanceof HostRpcError && e.code === RPC_CODES.notFound && /not found/.test(e.message));
  await assert.rejects(host.click("9", { ref: "a" }), (e: unknown) => e instanceof HostRpcError && e.code === RPC_CODES.tookOver);
  await assert.rejects(host.hover("9", { ref: "a" }), HostCancelledError);
});

test("events from the host reach every listener until it unsubscribes", async () => {
  const { fake, host } = await connect((req, r) => r.result({ ok: true }));
  await host.info(); // connect
  const seen: Array<{ type: string; data?: unknown }> = [];
  const off = host.onEvent((e) => seen.push(e));
  host.onEvent(() => {
    throw new Error("a broken listener must not break the connection");
  });
  fake.event("input", { active: true, x: 10, y: 20 });
  fake.event("takeover");
  await tick();
  assert.deepEqual(seen, [{ type: "input", data: { active: true, x: 10, y: 20 } }, { type: "takeover", data: undefined }]);
  off();
  fake.event("input", { active: false });
  await tick();
  assert.equal(seen.length, 2);
  assert.equal((await host.info()).ok, true, "the connection survives a throwing listener");
});

test("events interleaved with a response do not confuse request matching", async () => {
  const { fake, host } = await connect((req, r) => {
    fake.event("input", { active: true });
    r.result({ ok: true, method: "input" });
    fake.event("input", { active: false });
  });
  const seen: boolean[] = [];
  host.onEvent((e) => seen.push((e.data as { active: boolean }).active));
  const result = await host.click("1", { ref: "a" });
  await tick();
  assert.equal(result.method, "input");
  assert.deepEqual(seen, [true, false]);
});

test("aborting a request rejects it as cancelled and tells the host to stop", async () => {
  const { fake, host } = await connect((req, r) => {
    if (req.method === "cancel") r.result({ cancelled: true });
    // click is never answered
  });
  const abort = new AbortController();
  host.setAbortSignal(abort.signal);
  const pending = host.click("1", { ref: "a" });
  await tick();
  abort.abort();
  await assert.rejects(pending, HostCancelledError);
  await tick();
  assert.deepEqual(fake.methods(), ["click", "cancel"]);
});

test("a signal that is already aborted rejects without sending anything", async () => {
  const { fake, host } = await connect((req, r) => r.result({ ok: true }));
  await host.info();
  const before = fake.requests.length;
  const abort = new AbortController();
  abort.abort();
  host.setAbortSignal(abort.signal);
  await assert.rejects(host.listWindows(), HostCancelledError);
  assert.equal(fake.requests.length, before);
  host.setAbortSignal(undefined);
  assert.equal((await host.info()).ok, true, "the host takes new work once the signal is cleared");
});

test("a dropped connection is retried for read-only calls", async () => {
  let first = true;
  const { fake, host } = await connect((req, r, socket) => {
    if (first) {
      first = false;
      socket.destroy();
      return;
    }
    r.result([{ id: "1" }]);
  });
  assert.deepEqual(await host.listWindows(), [{ id: "1" }]);
  assert.deepEqual(fake.methods(), ["list_windows", "list_windows"]);
  assert.equal(fake.connections, 2);
});

test("a dropped connection is never retried for an action, so nothing is clicked twice", async () => {
  const { fake, host } = await connect((req, r, socket) => {
    if (req.method === "click") socket.destroy();
    else r.result({ ok: true });
  });
  await host.info();
  await assert.rejects(host.click("1", { ref: "a" }), /disconnected/);
  await tick(50);
  assert.equal(fake.methods().filter((m) => m === "click").length, 1);
});

test("every method has its own timeout, and actions are bounded well under the old blanket 30 s", () => {
  for (const method of ["click", "hover", "scroll", "drag", "set_value", "press_key"] as const) {
    assert.ok(METHOD_TIMEOUT_MS[method] <= 25_000, method);
  }
  assert.ok(METHOD_TIMEOUT_MS.type_text > METHOD_TIMEOUT_MS.click, "typing a long text is allowed longer");
  assert.ok(METHOD_TIMEOUT_MS.ping <= 5_000);
  assert.ok(METHOD_TIMEOUT_MS.get_window_state >= 30_000, "observation of a large tree is allowed longer");
});

test("a request that is never answered times out on its own method's clock and cancels the host", async () => {
  const { fake, host } = await connect((req, r) => {
    if (req.method === "ping" || req.method === "cancel") r.result({ ok: true });
  });
  await host.info(); // connect first, with real timers
  mock.timers.enable({ apis: ["setTimeout"] });
  const pending = host.hover("1", { ref: "a" });
  const outcome = pending.then(() => "resolved", (e: Error) => e.message);
  await Promise.resolve();
  mock.timers.tick(METHOD_TIMEOUT_MS.hover - 1);
  mock.timers.tick(2);
  assert.match(await outcome, /hover timed out/);
  mock.timers.reset();
  await tick();
  assert.ok(fake.methods().includes("cancel"));
});

test("simulateTakeover calls the test hook", async () => {
  const { fake, host } = await connect((req, r) => r.result({ tripped: 1 }));
  assert.deepEqual(await host.simulateTakeover(), { tripped: 1 });
  assert.equal(fake.requests[0]?.method, "simulate_takeover");
});

test("disposing the client fails whatever is still waiting", async () => {
  const { host } = await connect(() => undefined);
  const pending = host.click("1", { ref: "a" });
  await tick();
  host.dispose();
  await assert.rejects(pending, HostCancelledError);
  await assert.rejects(host.info(), HostCancelledError);
});
